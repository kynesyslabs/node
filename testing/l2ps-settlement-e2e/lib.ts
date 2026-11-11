/**
 * Shared plumbing for the L2PS settlement e2e: run-dir logging and checks,
 * node RPC reads, database state digests and the SDK client path. Every
 * transfer is built by the SDK (`buildSettledL2PSTransfer`, `L2PS.encryptTx`,
 * `demos.sign`) and sent through `confirm` + `broadcast`; nothing here
 * assembles a transaction by hand.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { Demos } from "@kynesyslabs/demosdk/websdk"
import { L2PS, buildSettledL2PSTransfer } from "@kynesyslabs/demosdk/l2ps"
import type { Wallet } from "./wallets"

function must(name: string): string {
    const v = process.env[name]
    if (!v) throw new Error(`${name} is not set (run through run.sh)`)
    return v
}

export const RUN_DIR = must("RUN_DIR")
export const LOG_DIR = `${RUN_DIR}/logs`
export const EVIDENCE_DIR = `${RUN_DIR}/evidence`
export const UID = must("L2PS_UID")
const COMPOSE = ["compose", "--env-file", must("ENVFILE"), "-p", must("PROJECT"), "-f", must("COMPOSE_FILE")]
mkdirSync(LOG_DIR, { recursive: true })
mkdirSync(EVIDENCE_DIR, { recursive: true })

export interface Node {
    i: number
    name: string
    rpc: string
    member: boolean
    db: string
}
export const NODES: Node[] = [1, 2, 3, 4].map(i => ({
    i,
    name: `node-${i}`,
    rpc: `http://127.0.0.1:${must(`RPC_PORT_${i}`)}`,
    member: i <= 2,
    db: `node${i}_db`,
}))
export const MEMBERS = NODES.filter(n => n.member)

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
export function evidence(name: string, value: unknown) {
    writeFileSync(`${EVIDENCE_DIR}/${name}.json`, json(value) + "\n")
}

export interface Check {
    id: string
    title: string
    pass: boolean
    detail: string
}
export const checks: Check[] = []
export function check(id: string, title: string, pass: boolean, detail = ""): boolean {
    checks.push({ id, title, pass, detail })
    say(`${pass ? "PASS" : "FAIL"} [${id}] ${title}${detail ? ` -- ${detail}` : ""}`)
    return pass
}

export async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
    stepLog = `${LOG_DIR}/${name}.log`
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

export function docker(args: string[], timeoutMs = 120_000): { ok: boolean; out: string } {
    if (!DOCKER_BIN) throw new Error("docker not found in /usr/bin, /usr/local/bin or /opt/homebrew/bin")
    const r = spawnSync(DOCKER_BIN, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 512 * 1024 * 1024 })
    return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() }
}
export const compose = (args: string[], timeoutMs?: number) => docker([...COMPOSE, ...args], timeoutMs)

export function psql(db: string, sql: string): string {
    const r = compose(["exec", "-T", "postgres", "psql", "-U", "demosuser", "-d", db, "-At", "-F", "|", "-c", sql])
    if (!r.ok) throw new Error(`psql ${db}: ${r.out.slice(0, 400)}`)
    return r.out
}

// ---- node RPC ---------------------------------------------------------------

export async function nodeCall(node: Node, message: string, data: unknown = {}, timeoutMs = 10_000) {
    const res = await fetch(node.rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "nodeCall", params: [{ message, data, muid: "l2ps-settle-e2e" }] }),
        signal: AbortSignal.timeout(timeoutMs),
    })
    return (await res.json()) as { result: number; response: any; extra?: any }
}

export async function tip(node: Node): Promise<number> {
    try {
        const r = await nodeCall(node, "getLastBlockNumber", {}, 4000)
        return typeof r.response === "number" ? r.response : -1
    } catch {
        return -1
    }
}
export const tips = () => Promise.all(NODES.map(tip))

export async function blockAt(node: Node, height: number): Promise<any | null> {
    try {
        const r = await nodeCall(node, "getBlockByNumber", { blockNumber: height })
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

export async function txStatus(node: Node, hash: string): Promise<any> {
    try {
        const r = await nodeCall(node, "getTransactionStatus", { hash })
        return r.response
    } catch (error) {
        return { state: "error", error: String(error) }
    }
}

export async function accountOn(node: Node, address: string): Promise<{ balance: bigint; nonce: number } | null> {
    try {
        const r = await nodeCall(node, "getAddressInfo", { address })
        if (r.result !== 200 || !r.response) return null
        return { balance: BigInt(String(r.response.balance ?? "0")), nonce: Number(r.response.nonce ?? 0) }
    } catch {
        return null
    }
}

/** Waits until every listed node is at or past `height`. */
export async function waitHeight(height: number, nodes: Node[] = NODES, maxMs = 300_000): Promise<number[]> {
    const deadline = Date.now() + maxMs
    let t = await Promise.all(nodes.map(tip))
    while (Date.now() < deadline && !t.every(x => x >= height)) {
        await sleep(2000)
        t = await Promise.all(nodes.map(tip))
    }
    return t
}
export async function waitBlocks(n: number, nodes: Node[] = NODES, maxMs = 300_000) {
    const start = Math.max(...(await Promise.all(nodes.map(tip))))
    return waitHeight(start + n, nodes, maxMs)
}

// ---- state ------------------------------------------------------------------

/**
 * Consensus GCR tables compared across validators. l2ps_* tables are
 * member-local by design (mempool, history) and are left out.
 */
export const STATE_TABLES = [
    "gcr_main",
    "gcr_subnets_txs",
    "gcr_storageprogram",
    "gcr_atomic_works",
    "gcr_resource_slots",
    "gcr_tlsnotary",
    "identity_commitments",
    "used_nullifiers",
]

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

export interface NodeState {
    node: string
    height: number
    blockHash: string | null
    /** md5 over pubkey:balance:nonce of every gcr_main row. */
    balancesDigest: string
    totalSupply: bigint
    accounts: number
    /** md5 per consensus table over every non-timestamp column, as "rows|md5". */
    tables: Record<string, string>
    balances: Map<string, { balance: bigint; nonce: number }>
}

function readNodeState(node: Node): Omit<NodeState, "height" | "blockHash"> {
    const rows = psql(node.db, "select pubkey, balance::text, nonce from gcr_main order by pubkey")
    const balances = new Map<string, { balance: bigint; nonce: number }>()
    let total = 0n
    const lines: string[] = []
    for (const line of rows.split("\n").filter(Boolean)) {
        const [pubkey, balance, nonce] = line.split("|")
        balances.set(pubkey, { balance: BigInt(balance), nonce: Number(nonce) })
        total += BigInt(balance)
        lines.push(`${pubkey}:${balance}:${nonce}`)
    }
    const balancesDigest = new Bun.CryptoHasher("md5").update(lines.join("\n")).digest("hex")
    const tables: Record<string, string> = {}
    for (const table of STATE_TABLES) {
        const cols = stateColumns(node.db, table)
        if (cols.length === 0) {
            tables[table] = "absent"
            continue
        }
        // points.lastUpdated is the wall clock of whichever node wrote the row, never agreed on
        const row = cols.map(c => (table === "gcr_main" && c === "points" ? `"points" - 'lastUpdated'` : `"${c}"`)).join(",")
        tables[table] = psql(
            node.db,
            `select count(*)::text || '|' || coalesce(md5(string_agg(r, E'\\n' order by r)), '-') from (select row(${row})::text r from "${table}") s`,
        )
    }
    return { node: node.name, balancesDigest, totalSupply: total, accounts: balances.size, tables, balances }
}

/**
 * One consistent reading of every node: all at the same height with the same
 * block hash before and after the database reads, so no block landed between.
 */
export async function quiescentStates(nodes: Node[] = NODES, maxMs = 180_000): Promise<NodeState[]> {
    const deadline = Date.now() + maxMs
    let last = ""
    while (Date.now() < deadline) {
        const before = await Promise.all(nodes.map(tip))
        if (before.some(t => t < 0) || new Set(before).size !== 1) {
            last = `tips ${before.join("/")}`
            await sleep(1500)
            continue
        }
        const height = before[0]
        const hashes = await Promise.all(nodes.map(async n => (await blockAt(n, height))?.hash ?? null))
        const states = nodes.map(readNodeState)
        const after = await Promise.all(nodes.map(tip))
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
        if (s.totalSupply !== first.totalSupply) diffs.push(`${s.node} total supply ${s.totalSupply} != ${first.totalSupply}`)
        for (const t of STATE_TABLES) {
            if (s.tables[t] !== first.tables[t]) diffs.push(`${s.node} ${t} ${s.tables[t]} != ${first.node} ${first.tables[t]}`)
        }
    }
    if (diffs.length > 0) {
        // Name the accounts that differ, so a divergence is readable from the report.
        const all = new Set(states.flatMap(s => [...s.balances.keys()]))
        let named = 0
        for (const a of all) {
            const per = states.map(s => s.balances.get(a))
            if (new Set(per.map(p => (p ? `${p.balance}/${p.nonce}` : "absent"))).size > 1 && named++ < 20) {
                diffs.push(`account ${a}: ${per.map((p, k) => `${states[k].node}=${p ? `${p.balance}/${p.nonce}` : "absent"}`).join(" ")}`)
            }
        }
    }
    return diffs
}

export function stateSummary(states: NodeState[]) {
    return states.map(s => ({
        node: s.node,
        height: s.height,
        blockHash: s.blockHash,
        balancesDigest: s.balancesDigest,
        totalSupply: s.totalSupply,
        accounts: s.accounts,
        tables: s.tables,
    }))
}

/** Balance and nonce change of every account that moved between two readings of one node. */
export function changedAccounts(before: NodeState, after: NodeState): Map<string, { delta: bigint; nonceDelta: number }> {
    const out = new Map<string, { delta: bigint; nonceDelta: number }>()
    const keys = new Set([...before.balances.keys(), ...after.balances.keys()])
    for (const k of keys) {
        const b = before.balances.get(k) ?? { balance: 0n, nonce: 0 }
        const a = after.balances.get(k) ?? { balance: 0n, nonce: 0 }
        if (a.balance !== b.balance || a.nonce !== b.nonce) {
            out.set(k, { delta: a.balance - b.balance, nonceDelta: a.nonce - b.nonce })
        }
    }
    return out
}

// ---- SDK client -------------------------------------------------------------

const clients = new Map<string, any>()
export async function client(w: Wallet, node: Node): Promise<any> {
    const key = `${w.label}@${node.name}`
    if (clients.has(key)) return clients.get(key)
    if (!w.mnemonic) throw new Error(`${w.label} has no key`)
    const d = new Demos()
    await d.connect(node.rpc)
    await d.connectWallet(w.mnemonic, { algorithm: "ed25519" })
    const address = (await d.getEd25519Address()).toLowerCase()
    if (address !== w.address) throw new Error(`${w.label}: SDK derives ${address}, genesis has ${w.address}`)
    clients.set(key, d)
    return d
}

let subnet: any = null
export async function subnetClient(): Promise<any> {
    if (subnet) return subnet
    const read = (f: string) => Buffer.from(readFileSync(`${RUN_DIR}/inputs/l2ps-member/${UID}/${f}`, "utf8").trim(), "hex").toString("binary")
    subnet = await L2PS.create(read("private_key.txt"), read("iv.txt"))
    subnet.setConfig({ uid: UID, config: { created_at_block: 0, known_rpcs: MEMBERS.map(m => m.rpc) } })
    return subnet
}

export interface SendOptions {
    to: string
    amount: bigint
    nonce?: number
    /** Nonce of the outer envelope; defaults to the transfer's. */
    outerNonce?: number
    chainId?: number
    settle?: boolean
}

export interface SendResult {
    tag: string
    from: string
    sender: string
    to: string
    via: string
    amount: bigint
    fee: bigint
    nonce: number
    innerHash: string
    outerHash: string
    submittedAt: number
    answeredAt: number
    accepted: boolean
    stage: "build" | "confirm" | "broadcast" | "accepted"
    message: string
    /** The signed envelope, kept to replay it. */
    envelope?: any
}

function flatten(v: unknown): string {
    return safeJson(v).slice(0, 2000)
}

/** Builds a transfer with the SDK, encrypts it for the subnet and submits it through `via`. */
export async function sendTransfer(tag: string, w: Wallet, via: Node, o: SendOptions): Promise<SendResult> {
    const base = { tag, from: w.label, sender: w.address, to: o.to, via: via.name, amount: o.amount }
    let inner: any
    let signed: any
    try {
        const demos = await client(w, via)
        inner = await buildSettledL2PSTransfer(demos, {
            to: o.to,
            amount: o.amount,
            l2psUid: UID,
            nonce: o.nonce,
            chainId: o.chainId,
            settle: o.settle,
        })
        const encrypted = await (await subnetClient()).encryptTx(inner)
        const outer = await demos.tx.prepare()
        outer.content.type = "l2psEncryptedTx"
        outer.content.to = encrypted.content.to
        outer.content.amount = 0
        outer.content.data = encrypted.content.data
        outer.content.nonce = o.outerNonce ?? inner.content.nonce
        outer.content.timestamp = Date.now()
        signed = await demos.sign(outer)
    } catch (error) {
        return {
            ...base, fee: 0n, nonce: o.nonce ?? -1, innerHash: "", outerHash: "", submittedAt: Date.now(), answeredAt: Date.now(),
            accepted: false, stage: "build", message: `build failed: ${String(error).slice(0, 500)}`,
        }
    }
    return submitEnvelope(tag, w, via, signed, inner, base)
}

/** Sends an already signed envelope again, as a replaying relay would. */
export async function replayEnvelope(tag: string, w: Wallet, via: Node, original: SendResult): Promise<SendResult> {
    return submitEnvelope(tag, w, via, original.envelope.signed, original.envelope.inner, {
        tag, from: w.label, sender: w.address, to: original.to, via: via.name, amount: original.amount,
    })
}

async function submitEnvelope(tag: string, w: Wallet, via: Node, signed: any, inner: any, base: any): Promise<SendResult> {
    const demos = await client(w, via)
    const settlement = inner?.content?.data?.[1]?.settlement
    const fee = settlement?.fee ? BigInt(settlement.fee) : 0n
    const common = {
        ...base,
        fee,
        nonce: Number(inner.content.nonce),
        innerHash: inner.hash,
        outerHash: signed.hash,
        envelope: { signed: structuredClone(signed), inner },
    }
    const submittedAt = Date.now()
    try {
        const validity: any = await demos.confirm(signed)
        const data = validity?.response?.data
        if (!data?.valid) {
            return { ...common, submittedAt, answeredAt: Date.now(), accepted: false, stage: "confirm", message: String(data?.message ?? flatten(validity)).trim() }
        }
        const sent: any = await demos.broadcast(validity)
        const accepted = sent?.result === 200
        const inner2 = sent?.response
        const message = accepted
            ? flatten(inner2?.message ?? inner2 ?? sent)
            : String(inner2?.extra ?? inner2?.response?.extra ?? sent?.extra ?? flatten(sent))
        return { ...common, submittedAt, answeredAt: Date.now(), accepted, stage: accepted ? "accepted" : "broadcast", message }
    } catch (error) {
        return { ...common, submittedAt, answeredAt: Date.now(), accepted: false, stage: "broadcast", message: `threw: ${String(error).slice(0, 500)}` }
    }
}

export interface Settlement {
    status: string
    l1BatchHash: string | null
    l1Block: number | null
    message: string | null
    /** When the harness first saw the final status. */
    seenAt: number | null
    batchedSeenAt: number | null
}

/**
 * Follows accepted transfers in their senders' history on the member that
 * took them until each is confirmed or failed, or until the deadline. Any
 * status in `stopAt` also ends the wait for that transfer.
 */
export async function followSettlement(
    sends: SendResult[],
    wallets: Record<string, Wallet>,
    maxMs: number,
    stopAt: string[] = ["confirmed", "failed"],
): Promise<Map<string, Settlement>> {
    const out = new Map<string, Settlement>()
    const pending = sends.filter(s => s.accepted)
    for (const s of pending) out.set(s.innerHash, { status: "unseen", l1BatchHash: null, l1Block: null, message: null, seenAt: null, batchedSeenAt: null })
    const deadline = Date.now() + maxMs
    let lastLine = ""
    while (Date.now() < deadline) {
        const open = pending.filter(s => !stopAt.includes(out.get(s.innerHash)!.status))
        if (open.length === 0) break
        const bySenderNode = new Map<string, SendResult[]>()
        for (const s of open) {
            const k = `${s.from}@${s.via}`
            bySenderNode.set(k, [...(bySenderNode.get(k) ?? []), s])
        }
        await Promise.all(
            [...bySenderNode.values()].map(async group => {
                const s0 = group[0]
                const via = NODES.find(n => n.name === s0.via)!
                try {
                    const page = await (await client(wallets[s0.from], via)).getL2PSHistory(UID, { limit: 100 })
                    for (const s of group) {
                        const row = page.transactions.find((t: any) => t.hash === s.innerHash || t.encrypted_hash === s.outerHash)
                        if (!row) continue
                        const rec = out.get(s.innerHash)!
                        if (row.status === "batched" && rec.batchedSeenAt === null) rec.batchedSeenAt = Date.now()
                        if (row.status !== rec.status) {
                            rec.status = row.status
                            rec.l1BatchHash = row.l1_batch_hash ?? rec.l1BatchHash
                            rec.l1Block = row.l1_block_number ?? rec.l1Block
                            rec.message = row.execution_message ?? null
                            if (stopAt.includes(row.status)) rec.seenAt = Date.now()
                        }
                    }
                } catch (error) {
                    lastLine = `history read failed for ${s0.from}@${s0.via}: ${String(error).slice(0, 200)}`
                }
            }),
        )
        const counts: Record<string, number> = {}
        for (const s of pending) counts[out.get(s.innerHash)!.status] = (counts[out.get(s.innerHash)!.status] ?? 0) + 1
        const line = `settlement: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ")}, tips ${(await tips()).join("/")}`
        if (line !== lastLine) say(line)
        lastLine = line
        await sleep(3000)
    }
    return out
}

export function quantiles(xs: number[]) {
    if (xs.length === 0) return { n: 0 }
    const s = [...xs].sort((a, b) => a - b)
    const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]
    return { n: s.length, min: s[0], p50: q(0.5), p95: q(0.95), max: s[s.length - 1], mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length) }
}
