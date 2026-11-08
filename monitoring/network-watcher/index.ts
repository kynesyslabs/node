import { createHash } from "node:crypto"

type Fetch = (url: string, init?: RequestInit) => Promise<Response>
type Block = { number: number; hash: string; previous?: unknown; timestamp: number; signers: string[] }
type Endpoint = { url: string; genesis: string; host: string; errors: number; up: number; head?: Block; shard?: number
    unsupported: Map<string, number>; blocks: Map<number, Block> }
// Bounds on what one endpoint can make the watcher parse, compute or label in one poll. They do not bound
// churn: validator labels come unverified from the window endpoint, so every listed endpoint is trusted for
// them (up to 1000 new identities x 2 series per poll); the cap stays loose until the validator count is known.
const MAX_IDENTITIES = 1000
const MAX_BODY = 4 * 1024 * 1024
const RETRY_UNSUPPORTED_SECONDS = 600
const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v)
const height = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0
const key = (v: unknown): v is string => typeof v === "string" && v.length > 0
const seconds = (v: unknown): number => {
    const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw Error("timestamp")
    return Math.floor(n >= 1e12 ? n / 1000 : n)
}
export function block(v: unknown, number: number): Block {
    if (!object(v) || v.number !== number || !key(v.hash)) throw Error("block")
    if (number === 0) return { number, hash: v.hash, timestamp: 0, signers: [] }
    const signatures = v.validation_data?.signatures
    if (!object(signatures) || Object.keys(signatures).length > MAX_IDENTITIES ||
        !Object.entries(signatures).every(([k, s]) => key(k) && key(s))) throw Error("signatures")
    return { number, hash: v.hash, previous: v.content?.previousHash, timestamp: seconds(v.content?.timestamp), signers: Object.keys(signatures) }
}
export function fork(blocks: Block[]): number {
    return Number(blocks.some(a => blocks.some(b => a.number === b.number && a.hash !== b.hash)))
}
export function signerWindow(blocks: Block[], validators?: string[]) {
    const set = new Set(validators ?? blocks.flatMap(b => b.signers))
    if (set.size > MAX_IDENTITIES) throw Error("validator set size")
    return new Map([...set].map(v => {
        const signed = blocks.filter(b => b.signers.includes(v))
        return [v, { count: signed.length, last: Math.max(0, ...signed.map(b => b.number)) }]
    }))
}
export const validatorLabel = (v: string) => v.length <= 128 ? v : `sha256:${createHash("sha256").update(v).digest("hex")}`
const quote = (v: string) => JSON.stringify(v).replace(/\r/g, "\\r")

export class Watcher {
    endpoints: Endpoint[]
    headMax = 0
    lastAdvance = 0
    started = false
    now = 0
    snapshot = ""
    values: string[] = []
    lastSigned = new Map<string, number>()
    constructor(urls: string[], readonly window = 20, readonly fetcher: Fetch = fetch, readonly timeout = 8000) {
        this.endpoints = urls.map(url => {
            const parsed = new URL(url)
            if (!["http:", "https:"].includes(parsed.protocol)) throw Error("WATCH_RPC_URLS requires HTTP(S)")
            // The node serves GET /genesis beside its POST / root, so keep any proxy path prefix.
            parsed.pathname = parsed.pathname.replace(/\/?$/, "/genesis")
            return { url, genesis: parsed.href, host: parsed.host, errors: 0, up: 0, unsupported: new Map(), blocks: new Map() }
        })
        if (!urls.length || new Set(this.endpoints.map(e => e.host)).size !== urls.length) throw Error("WATCH_RPC_URLS requires distinct hosts")
        this.snapshot = this.render()
    }
    async attempt<T>(e: Endpoint, fn: () => Promise<T>): Promise<T | undefined> {
        try { return await fn() } catch { e.errors++; return undefined }
    }
    async json(e: Endpoint, init?: RequestInit): Promise<any> {
        const reply = await this.fetcher(init ? e.url : e.genesis, {
            ...init, signal: AbortSignal.timeout(this.timeout), redirect: "error",
        })
        if (!reply.ok || Number(reply.headers.get("content-length")) > MAX_BODY) throw Error("HTTP")
        // Count bytes as they arrive, so an undeclared (chunked) body is never buffered past the cap.
        const reader = reply.body!.getReader(), decoder = new TextDecoder()
        let text = "", size = 0
        for (let r = await reader.read(); !r.done; r = await reader.read()) {
            if ((size += r.value.byteLength) > MAX_BODY) { await reader.cancel(); throw Error("body size") }
            text += decoder.decode(r.value, { stream: true })
        }
        return JSON.parse(text + decoder.decode())
    }
    async rpc(e: Endpoint, message: string, data = {}): Promise<any> {
        if ((e.unsupported.get(message) ?? 0) > this.now) return undefined
        e.unsupported.delete(message)
        const reply = await this.json(e, { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ method: "nodeCall", params: [{ message, data }] }) })
        if (!object(reply) || reply.result !== 200) {
            if (reply?.result === 404 && JSON.stringify(reply.response)?.includes("Unknown message")) e.unsupported.set(message, this.now + RETRY_UNSUPPORTED_SECONDS)
            throw Error("RPC")
        }
        return reply.response
    }
    async readBlock(e: Endpoint, n: number) { return block(await this.rpc(e, "getBlockByNumber", { blockNumber: n }), n) }
    async poll(now = Date.now() / 1000) {
        this.values = []
        this.now = now
        if (!this.started) { this.started = true; this.lastAdvance = now }
        await Promise.all(this.endpoints.map(async e => {
            e.head = undefined
            e.up = 0
            await this.attempt(e, async () => {
                const final = await this.attempt(e, async () => {
                    const f = await this.rpc(e, "getFinalizedHead")
                    if (f === undefined && e.unsupported.has("getFinalizedHead")) return undefined
                    if (!object(f) || !height(f.number) || !key(f.hash)) throw Error("finalized head")
                    return f.number as number
                })
                const n = final ?? await this.rpc(e, "getLastBlockNumber")
                if (!height(n)) throw Error("head")
                e.head = await this.readBlock(e, n)
                e.up = 1
            })
        }))
        const reachable = this.endpoints.filter(e => e.head)
        if (reachable.length) {
            // Advance is measured against the previous observation, not an all-time peak,
            // so one inflated head or a chain reset cannot hold the stall alert on.
            const max = Math.max(...reachable.map(e => e.head!.number))
            if (max > this.headMax) this.lastAdvance = now
            this.headMax = max
        }
        this.emit("head_max", this.headMax)
        this.emit("head_last_advance_timestamp_seconds", this.lastAdvance)
        const compared = Math.max(0, Math.min(...reachable.map(e => e.head!.number)) - 2)
        const copies = reachable.length ? await Promise.all(reachable.map(e => this.attempt(e, () => this.readBlock(e, compared)))) : []
        this.emit("fork_detected", fork(copies.filter((b): b is Block => b !== undefined)))
        // Use one endpoint's complete history; never mix chains or call a partial window complete.
        for (const [i, e] of reachable.entries()) {
            if (!copies[i] || compared === 0) continue
            const blocks = await this.attempt(e, async () => {
                const read = await Promise.all(Array.from({ length: Math.min(this.window, compared) },
                    (_, j) => j === 0 ? copies[i]! : e.blocks.get(compared - j) ?? this.readBlock(e, compared - j)))
                // Reuse earlier reads only while the fresh comparison block's hash chain reaches them.
                const linked = read.every((b, j) => j === 0 || read[j - 1]!.previous === b.hash)
                e.blocks = new Map(linked ? read.map(b => [b.number, b] as const) : [])
                if (!linked) throw Error("chain")
                return read
            })
            if (!blocks) continue
            const validators = await this.attempt(e, async () => {
                const set = await this.rpc(e, "getValidatorSet", { blockNumber: compared })
                if (set === undefined && e.unsupported.has("getValidatorSet")) return undefined
                if (!object(set) || set.blockNumber !== compared || !Array.isArray(set.validators) || set.validators.length > MAX_IDENTITIES ||
                    !set.validators.every((v: unknown) => object(v) && key(v.identity) &&
                        (v.status === null || typeof v.status === "string") && (v.validAt === null || height(v.validAt)))) throw Error("validator set")
                return set.validators.filter((v: any) => v.status === "2" && v.validAt !== null && v.validAt <= compared).map((v: any) => v.identity) as string[]
            })
            const summary = await this.attempt(e, async () => signerWindow(blocks, validators))
            if (!summary) continue
            if (!e.shard) await this.attempt(e, async () => {
                const genesis = await this.json(e)
                const size = genesis?.properties?.shardSize
                if (!height(size) || size < 3 || size > 100) throw Error("shard size")
                e.shard = size
            })
            this.emit("validator_set_size", summary.size)
            for (const source of ["rpc", "signers"]) this.emit("validator_set_source", Number(source === (validators ? "rpc" : "signers")), { source })
            this.emit("block_signers", blocks[0]!.signers.length)
            if (e.shard) this.emit("signature_threshold", Math.floor(e.shard * 2 / 3) + 1)
            const last = new Map<string, number>()
            for (const [v, stats] of summary) {
                last.set(v, Math.max(stats.last, this.lastSigned.get(v) ?? 0))
                this.emit("validator_last_signed_height", last.get(v)!, { validator: validatorLabel(v) })
                this.emit("validator_signed_in_window", stats.count, { validator: validatorLabel(v) })
            }
            this.lastSigned = last
            break
        }
        this.snapshot = this.render()
    }
    emit(name: string, value: number, labels: Record<string, string> = {}) {
        const pairs = Object.entries(labels).map(([k, v]) => `${k}=${quote(v)}`).join(",")
        this.values.push(`demos_watch_${name}${pairs ? `{${pairs}}` : ""} ${value}`)
    }
    metrics() { return this.snapshot || this.render() }
    render() {
        const metrics = [...this.values]
        for (const e of this.endpoints) {
            const label = `{endpoint=${quote(e.host)}}`
            metrics.push(`demos_watch_endpoint_up${label} ${e.up}`, `demos_watch_poll_errors_total${label} ${e.errors}`)
            if (e.head) metrics.push(`demos_watch_endpoint_head${label} ${e.head.number}`,
                `demos_watch_endpoint_head_timestamp_seconds${label} ${e.head.timestamp}`)
        }
        const names = [...new Set(metrics.map(m => m.split(/[ {]/)[0]!))]
        return names.map(n => `# HELP ${n} Public RPC network observation: ${n.slice(12)}.\n# TYPE ${n} ${n.endsWith("_total") ? "counter" : "gauge"}\n` + metrics.filter(m => m.startsWith(n + " ") || m.startsWith(n + "{")).join("\n")).join("\n") + "\n"
    }
}

if (import.meta.main) {
    const integer = (name: string, fallback: number, max: number) => {
        const n = Number(process.env[name] ?? fallback)
        if (!Number.isSafeInteger(n) || n < 1 || n > max) throw Error(`Invalid ${name}`)
        return n
    }
    const watcher = new Watcher((process.env.WATCH_RPC_URLS ?? "").split(",").map(s => s.trim()).filter(Boolean), integer("WATCH_SIGN_WINDOW", 20, 20))
    const poll = integer("WATCH_POLL_SECONDS", 15, 120)
    Bun.serve({ port: integer("WATCH_PORT", 9465, 65535), fetch: request => new URL(request.url).pathname === "/metrics"
        ? new Response(watcher.metrics(), { headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" } })
        : new Response("Not found", { status: 404 }) })
    while (true) { await watcher.poll(); await Bun.sleep(poll * 1000) }
}
