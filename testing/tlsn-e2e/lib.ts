/**
 * Shared plumbing for the TLSN e2e: run-dir logging and checks, node RPC
 * reads, database state digests, the SDK client path and a stand-in for the
 * operator's reverse proxy in front of node relays. Every transaction is
 * built and signed by the SDK; nothing here assembles one by hand.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { connect } from "node:net"
import { Demos } from "@kynesyslabs/demosdk/websdk"
import type { Wallet } from "./wallets"

function must(name: string): string {
    const v = process.env[name]
    if (!v) throw new Error(`${name} is not set (run through run.sh)`)
    return v
}

export const RUN_DIR = must("RUN_DIR")
export const LOG_DIR = `${RUN_DIR}/logs`
export const EVIDENCE_DIR = `${RUN_DIR}/evidence`
export const INPUTS = `${RUN_DIR}/inputs`
export const SDK_TREE = must("SDK_TREE")
export const REPO_ROOT = must("REPO_ROOT")
const COMPOSE = ["compose", "--env-file", must("ENVFILE"), "-p", must("PROJECT"), "-f", must("COMPOSE_FILE")]
mkdirSync(LOG_DIR, { recursive: true })
mkdirSync(EVIDENCE_DIR, { recursive: true })

export interface Node {
    i: number
    name: string
    rpc: string
    db: string
}
export const NODES: Node[] = [1, 2, 3, 4].map(i => ({
    i,
    name: `node-${i}`,
    rpc: `http://127.0.0.1:${must(`RPC_PORT_${i}`)}`,
    db: `node${i}_db`,
}))
export const node = (i: number) => NODES[i - 1]

export interface Notary {
    k: number
    url: string
    publicKey: string
    trusted: boolean
}
export const NOTARIES: Notary[] = [1, 2, 3].map(k => ({
    k,
    url: `http://127.0.0.1:${must(`NOTARY_PORT_${k}`)}`,
    publicKey: readFileSync(`${INPUTS}/notary-${k}.pub`, "utf8").trim(),
    trusted: k !== 3,
}))
export const TRUSTED_KEYS = NOTARIES.filter(n => n.trusted).map(n => n.publicKey)

// ---- output ------------------------------------------------------------------

// The SDK logs while it builds and sends; the harness's own lines go through say().
const realOut = (s: string) => process.stdout.write(s + "\n")
const sdkLog = (...args: unknown[]) =>
    appendFileSync(`${LOG_DIR}/sdk-console.log`, args.map(a => (typeof a === "string" ? a : safeJson(a))).join(" ") + "\n")
console.log = sdkLog
console.info = sdkLog
console.debug = () => {}
console.warn = sdkLog
console.error = sdkLog

function safeJson(v: unknown): string {
    try {
        return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x))
    } catch {
        return String(v)
    }
}
export const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2)

let stepLog: string | null = null
export function say(line: string) {
    const l = `${new Date().toISOString()} ${line}`
    realOut(l)
    appendFileSync(`${LOG_DIR}/run.log`, l + "\n")
    if (stepLog) appendFileSync(stepLog, l + "\n")
}
/** A line in the current step's log only. */
export function note(line: string) {
    if (stepLog) appendFileSync(stepLog, `${new Date().toISOString()} ${line}\n`)
}
export function evidence(name: string, value: unknown) {
    writeFileSync(`${EVIDENCE_DIR}/${name}.json`, json(value) + "\n")
}

export type Verdict = "PASS" | "FAIL" | "SKIP"
export interface Check {
    step: string
    id: string
    title: string
    verdict: Verdict
    detail: string
}
export const checks: Check[] = []
let currentStep = "setup"
export function check(id: string, title: string, pass: boolean, detail = ""): boolean {
    record(id, title, pass ? "PASS" : "FAIL", detail)
    return pass
}
export function skip(id: string, title: string, reason: string) {
    record(id, title, "SKIP", reason)
}
function record(id: string, title: string, verdict: Verdict, detail: string) {
    checks.push({ step: currentStep, id, title, verdict, detail })
    say(`${verdict} [${id}] ${title}${detail ? ` -- ${detail}` : ""}`)
}

export async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
    stepLog = `${LOG_DIR}/${name}.log`
    currentStep = name
    const t0 = Date.now()
    say(`== ${name}`)
    try {
        return await fn()
    } catch (error) {
        check(name, "step ran to the end", false, error instanceof Error ? (error.stack ?? error.message) : String(error))
        return undefined
    } finally {
        say(`== ${name} done in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
        stepLog = null
    }
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ---- docker -----------------------------------------------------------------

// A fixed binary, not a PATH lookup: the harness holds devnet keys and wallet
// mnemonics, so it must not run whatever "docker" a writable PATH entry offers.
const DOCKER_BIN = ["/usr/bin/docker", "/usr/local/bin/docker", "/opt/homebrew/bin/docker"].find(p => existsSync(p))

export function docker(args: string[], timeoutMs = 120_000, input?: string): { ok: boolean; out: string } {
    if (!DOCKER_BIN) throw new Error("docker not found in /usr/bin, /usr/local/bin or /opt/homebrew/bin")
    const r = spawnSync(DOCKER_BIN, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 512 * 1024 * 1024, input })
    return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() }
}
export const compose = (args: string[], timeoutMs?: number, input?: string) => docker([...COMPOSE, ...args], timeoutMs, input)

export function psql(db: string, sql: string): string {
    const r = compose(["exec", "-T", "postgres", "psql", "-U", "demosuser", "-d", db, "-At", "-F", "|", "-c", sql])
    if (!r.ok) throw new Error(`psql ${db}: ${r.out.slice(0, 400)}`)
    return r.out
}

// ---- node RPC ---------------------------------------------------------------

export async function nodeCall(n: Node, message: string, data: unknown = {}, timeoutMs = 10_000, headers: Record<string, string> = {}) {
    const res = await fetch(n.rpc, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ method: "nodeCall", params: [{ message, data, muid: "tlsn-e2e" }] }),
        signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    try {
        return { http: res.status, ...(JSON.parse(text) as { result: number; response: any; extra?: any }) }
    } catch {
        return { http: res.status, result: res.status, response: text }
    }
}

export async function tip(n: Node): Promise<number> {
    try {
        const r = await nodeCall(n, "getLastBlockNumber", {}, 4000)
        return typeof r.response === "number" ? r.response : -1
    } catch {
        return -1
    }
}
export const tips = (nodes: Node[] = NODES) => Promise.all(nodes.map(tip))

export async function blockAt(n: Node, height: number): Promise<any | null> {
    try {
        const r = await nodeCall(n, "getBlockByNumber", { blockNumber: height })
        return r.result === 200 ? r.response : null
    } catch {
        return null
    }
}

/** Block timestamp in ms; blocks carry seconds or ms depending on the field's age. */
export function blockTimeMs(block: any): number | null {
    const raw = Number(block?.content?.timestamp ?? block?.timestamp)
    if (!Number.isFinite(raw) || raw <= 0) return null
    return raw < 1e12 ? raw * 1000 : raw
}

export async function txStatus(n: Node, hash: string): Promise<any> {
    try {
        const r = await nodeCall(n, "getTransactionStatus", { hash })
        return r.response
    } catch (error) {
        return { state: "error", error: String(error) }
    }
}

/** Waits until every listed node is at or past `height`. */
export async function waitHeight(height: number, nodes: Node[] = NODES, maxMs = 300_000): Promise<number[]> {
    const deadline = Date.now() + maxMs
    let t = await tips(nodes)
    while (Date.now() < deadline && !t.every(x => x >= height)) {
        await sleep(2000)
        t = await tips(nodes)
    }
    return t
}

/**
 * Polls until `hash` is included on every node, returning when each node
 * first reported it and the block it landed in.
 */
export async function waitIncluded(hash: string, maxMs = 120_000, nodes: Node[] = NODES) {
    const seen = new Map<string, { at: number; state: string; block: number | null }>()
    const deadline = Date.now() + maxMs
    while (Date.now() < deadline && seen.size < nodes.length) {
        await Promise.all(
            nodes
                .filter(n => !seen.has(n.name))
                .map(async n => {
                    const s = await txStatus(n, hash)
                    if (s?.state === "included" || s?.state === "failed") {
                        seen.set(n.name, { at: Date.now(), state: s.state, block: s.blockNumber ?? null })
                    }
                }),
        )
        if (seen.size < nodes.length) await sleep(500)
    }
    return seen
}

// ---- state ------------------------------------------------------------------

/** Consensus GCR tables compared across validators. */
export const STATE_TABLES = ["gcr_main", "gcr_tlsnotary", "gcr_storageprogram", "identity_commitments", "used_nullifiers"]

const columnCache = new Map<string, string[]>()
function stateColumns(db: string, table: string): string[] {
    const key = `${db}.${table}`
    if (!columnCache.has(key)) {
        const out = psql(
            db,
            `select column_name from information_schema.columns where table_schema='public' and table_name='${table}' ` +
                `and data_type not like 'timestamp%' and column_name not in ('createdAt','updatedAt','created_at','updated_at') ` +
                "order by ordinal_position",
        )
        columnCache.set(key, out ? out.split("\n").filter(Boolean) : [])
    }
    return columnCache.get(key)!
}
export function forgetColumns(db: string) {
    for (const k of [...columnCache.keys()]) if (k.startsWith(`${db}.`)) columnCache.delete(k)
}

export interface NodeState {
    node: string
    height: number
    blockHash: string | null
    /** md5 over pubkey:balance:nonce of every gcr_main row. */
    balancesDigest: string
    /** "rows|md5" per consensus table over every non-timestamp column. */
    tables: Record<string, string>
}

/**
 * Every node's digests in one psql session: with 2 s blocks, reading the
 * four databases one query at a time spans several blocks and never
 * yields a reading taken between two of them.
 */
function readStates(nodes: Node[]): Omit<NodeState, "height" | "blockHash">[] {
    const lines: string[] = []
    for (const n of nodes) {
        lines.push(`\\c ${n.db}`)
        lines.push(
            `select '${n.name}|balances|' || coalesce(md5(string_agg(pubkey || ':' || balance::text || ':' || nonce, E'\\n' order by pubkey)), '-') from gcr_main;`,
        )
        for (const table of STATE_TABLES) {
            const cols = stateColumns(n.db, table)
            if (cols.length === 0) {
                lines.push(`select '${n.name}|${table}|absent';`)
                continue
            }
            // points.lastUpdated is the wall clock of whichever node wrote the row, never agreed on
            const row = cols.map(c => (table === "gcr_main" && c === "points" ? `"points" - 'lastUpdated'` : `"${c}"`)).join(",")
            lines.push(
                `select '${n.name}|${table}|' || count(*)::text || '|' || coalesce(md5(string_agg(r, E'\\n' order by r)), '-') from (select row(${row})::text r from "${table}") s;`,
            )
        }
    }
    const r = compose(["exec", "-T", "postgres", "psql", "-U", "demosuser", "-d", "postgres", "-At", "-q", "-v", "ON_ERROR_STOP=1", "-f", "-"], 60_000, lines.join("\n") + "\n")
    if (!r.ok) throw new Error(`psql state read: ${r.out.slice(0, 400)}`)
    return nodes.map(n => {
        const tables: Record<string, string> = {}
        let balancesDigest = ""
        for (const line of r.out.split("\n")) {
            if (!line.startsWith(`${n.name}|`)) continue
            const [, what, ...rest] = line.split("|")
            if (what === "balances") balancesDigest = rest.join("|")
            else tables[what] = rest.join("|")
        }
        return { node: n.name, balancesDigest, tables }
    })
}

/**
 * One consistent reading of every node: all at the same height with the same
 * block hash before and after the database reads, so no block landed between.
 */
export async function quiescentStates(nodes: Node[] = NODES, maxMs = 180_000): Promise<NodeState[]> {
    const deadline = Date.now() + maxMs
    let last = ""
    // Column lookups are one exec each; done here they stay out of the timed window.
    for (const n of nodes) for (const t of STATE_TABLES) stateColumns(n.db, t)
    while (Date.now() < deadline) {
        const before = await tips(nodes)
        if (before.some(t => t < 0) || new Set(before).size !== 1) {
            last = `tips ${before.join("/")}`
            await sleep(300)
            continue
        }
        const height = before[0]
        const hashes = await Promise.all(nodes.map(async n => (await blockAt(n, height))?.hash ?? null))
        const states = readStates(nodes)
        const after = await tips(nodes)
        if (after.every(t => t === height)) {
            return states.map((s, k) => ({ ...s, height, blockHash: hashes[k] }))
        }
        last = `a block landed while reading (tips ${after.join("/")})`
    }
    throw new Error(`no quiescent reading within ${maxMs / 1000} s: ${last}`)
}

/** Where the nodes' states differ, or [] when they agree on everything compared. */
export function stateDifferences(states: NodeState[]): string[] {
    const diffs: string[] = []
    const first = states[0]
    for (const s of states.slice(1)) {
        if (s.blockHash !== first.blockHash) diffs.push(`${s.node} block hash at ${s.height} differs from ${first.node}`)
        if (s.balancesDigest !== first.balancesDigest) diffs.push(`${s.node} balances/nonces digest differs from ${first.node}`)
        for (const t of STATE_TABLES) {
            if (s.tables[t] !== first.tables[t]) diffs.push(`${s.node} ${t} ${s.tables[t]} != ${first.node} ${first.tables[t]}`)
        }
    }
    return diffs
}

/** The gcr_tlsnotary row of `tokenId` on one node, proof reduced to its sha256. */
export function tlsnRow(n: Node, tokenId: string): Record<string, string> | null {
    const out = psql(
        n.db,
        `select "tokenId", owner, domain, status, "storageType", txhash, coalesce("requestHeight"::text,''), ` +
            `coalesce("expiresAtHeight"::text,''), coalesce("attestationId",''), coalesce("storedAtHeight"::text,''), ` +
            `coalesce(encode(sha256(convert_to(proof,'UTF8')),'hex'),''), coalesce(length(proof),0)::text ` +
            `from gcr_tlsnotary where "tokenId" = '${tokenId.replace(/[^0-9a-f]/g, "")}'`,
    )
    if (!out) return null
    const [id, owner, domain, status, storageType, txhash, requestHeight, expiresAtHeight, attestationId, storedAtHeight, proofSha256, proofLength] =
        out.split("|")
    return { tokenId: id, owner, domain, status, storageType, txhash, requestHeight, expiresAtHeight, attestationId, storedAtHeight, proofSha256, proofLength }
}
export const tlsnRows = (tokenId: string) => NODES.map(n => tlsnRow(n, tokenId))

/** The stored proof text of `tokenId` on one node. */
export function tlsnProof(n: Node, tokenId: string): string {
    return psql(n.db, `select proof from gcr_tlsnotary where "tokenId" = '${tokenId.replace(/[^0-9a-f]/g, "")}'`)
}

/** Polls until `pred` holds on every node, returning when that happened or null. */
export async function waitAll<T>(read: (n: Node) => T, pred: (v: T) => boolean, maxMs = 60_000): Promise<{ values: T[]; at: number } | null> {
    const deadline = Date.now() + maxMs
    while (Date.now() < deadline) {
        const values = NODES.map(read)
        if (values.every(pred)) return { values, at: Date.now() }
        await sleep(500)
    }
    return null
}

// ---- SDK client -------------------------------------------------------------

export function loadWallets(): Record<string, Wallet> {
    return JSON.parse(readFileSync(`${INPUTS}/wallets.secret.json`, "utf8"))
}

const clients = new Map<string, Demos>()
export async function client(w: Wallet, n: Node): Promise<Demos> {
    const key = `${w.label}@${n.name}`
    if (clients.has(key)) return clients.get(key)!
    const d = new Demos()
    await d.connect(n.rpc)
    await d.connectWallet(w.mnemonic, { algorithm: "ed25519" })
    const address = (await d.getEd25519Address()).toLowerCase()
    if (address !== w.address) throw new Error(`${w.label}: SDK derives ${address}, genesis has ${w.address}`)
    clients.set(key, d)
    return d
}

/** What `confirm` answered on one node: whether it would admit the transaction and why not. */
export interface Admission {
    node: string
    valid: boolean
    message: string
    ms: number
}

export async function confirmOn(d: Demos, tx: any, n: Node): Promise<Admission> {
    const t0 = Date.now()
    try {
        const r: any = await d.confirm(tx)
        const data = r?.response?.data
        return { node: n.name, valid: data?.valid === true, message: String(data?.message ?? safeJson(r)).slice(0, 600), ms: Date.now() - t0 }
    } catch (error) {
        return { node: n.name, valid: false, message: `threw: ${String(error).slice(0, 600)}`, ms: Date.now() - t0 }
    }
}

// ---- relays -------------------------------------------------------------------

/**
 * The URL a prover on this host dials for a session URL a node handed out.
 * A node behind a public name answers wss://<host>/tlsn/<port>/<session>,
 * which an operator's reverse proxy maps to the node's <port>; here the
 * relay window is published 1:1 on loopback, so the same mapping is local.
 */
export function relayDialUrl(sessionUrl: string): string {
    const u = new URL(sessionUrl)
    const parts = u.pathname.split("/").filter(Boolean)
    if (u.protocol === "wss:" && parts[0] === "tlsn" && /^\d+$/.test(parts[1] ?? "") && parts.length === 3) {
        return `ws://127.0.0.1:${parts[1]}/${parts[2]}`
    }
    if (u.protocol === "ws:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1") && parts.length === 1) {
        return `ws://127.0.0.1:${u.port}/${parts[0]}`
    }
    throw new Error(`unexpected session URL ${sessionUrl}`)
}

/**
 * A plain websocket-to-TCP relay of the harness's own, for presentations a
 * node relay would never serve (another account's token): the node judges a
 * presentation, not the relay it came through.
 */
export function startLocalRelay(host: string, port: number) {
    type Link = { sock?: ReturnType<typeof connect>; q: Uint8Array[] }
    const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req, s) {
            if (s.upgrade(req, { data: { q: [] } as Link })) return
            return new Response("websocket only", { status: 400 })
        },
        websocket: {
            open(ws: any) {
                const sock = connect(port, host)
                ws.data.sock = sock
                sock.on("connect", () => {
                    for (const b of ws.data.q) sock.write(b)
                    ws.data.q = []
                })
                sock.on("data", (d: Buffer) => ws.sendBinary(d))
                sock.on("close", () => ws.close())
                sock.on("error", () => ws.close())
            },
            message(ws: any, m: string | Buffer) {
                const b = typeof m === "string" ? Buffer.from(m) : m
                if (ws.data.sock?.readyState === "open") ws.data.sock.write(b)
                else ws.data.q.push(b)
            },
            close(ws: any) {
                ws.data.sock?.end()
            },
        },
    })
    return { url: `ws://127.0.0.1:${server.port}/local`, stop: () => server.stop(true) }
}

export function quantiles(xs: number[]) {
    if (xs.length === 0) return { n: 0 }
    const s = [...xs].sort((a, b) => a - b)
    const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]
    return { n: s.length, min: s[0], p50: q(0.5), p95: q(0.95), max: s[s.length - 1], mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length) }
}
