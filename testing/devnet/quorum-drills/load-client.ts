/**
 * Load generator of the load-* quorum drills (run.sh scenario_load).
 *
 * run.sh runs it in a container of the image under test (the compose `load`
 * service, inputs/load mounted at /load), so transfers are built and signed by
 * the SDK the release ships, through the same confirm + broadcast path a
 * wallet uses. It reads its settings from the environment:
 *
 *   LOAD_URLS        comma-separated node RPC URLs; wallet j sends through URL j mod n
 *   LOAD_TPS         target transfers per second over all wallets (default 4)
 *   LOAD_DURATION_S  how long to send (default 300)
 *   LOAD_DRAIN_S     how long to keep following transfers after the last send (default 180)
 *   LOAD_WALLET_DIR  wallet<j>.identity (mnemonic) files, funded by the genesis (default /load)
 *   LOAD_WINDOW      transfers one wallet keeps in flight (default 18)
 *
 * A wallet sends one transfer at a time with the next nonce and keeps at most
 * LOAD_WINDOW of them unincluded: the node refuses a nonce more than 20 ahead,
 * so a wider window would measure refusals, not throughput. A tick that finds
 * no wallet free is counted as throttled. Every accepted transfer is followed
 * with getTransactionStatus on the node it was sent to until it is included.
 *
 * Prints progress to stderr and one `LOAD_RESULT <json>` line to stdout, which
 * judgeLoadDrill.ts reads (as `load` in its input). Exit codes: 0 the run was
 * carried out (whatever got included), 2 it could not start.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Demos } from "@kynesyslabs/demosdk/websdk"

export interface LoadTx {
    /** Wallet index, 0-based. */
    w: number
    nonce: number
    sentMs: number
    ok: boolean
    hash: string | null
    error?: string
    includedSeenMs: number | null
    blockNumber: number | null
}

export interface LoadResult {
    targetTps: number
    durationS: number
    drainS: number
    wallets: number
    urls: number
    window: number
    sent: number
    accepted: number
    rejected: number
    throttled: number
    included: number
    tStartMs: number
    tSendEndMs: number
    tEndMs: number
    /** Block timestamps (ms) of the blocks the transfers landed in, read from the first URL. */
    blockTimesMs: Record<string, number>
    /** Refusal messages with their counts, the 10 most frequent. */
    errors: { message: string; count: number }[]
    txs: LoadTx[]
}

interface Wallet {
    demos: any
    address: string
    url: string
    nextNonce: number
    inFlight: number
    busy: boolean
}

const log = (msg: string) => process.stderr.write(`[load ${new Date().toISOString().slice(11, 19)}] ${msg}\n`)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function num(name: string, fallback: number, min: number): number {
    const raw = process.env[name]
    const v = raw === undefined || raw === "" ? fallback : Number(raw)
    if (!Number.isFinite(v) || v < min) throw new Error(`${name} must be a number >= ${min}, got ${raw}`)
    return v
}

async function nodeCall(url: string, message: string, data: unknown, timeoutMs = 8000): Promise<any> {
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "nodeCall", params: [{ message, data, muid: "qdrill-load" }] }),
        signal: AbortSignal.timeout(timeoutMs),
    })
    return res.json()
}

function brief(v: unknown): string {
    const s = typeof v === "string" ? v : JSON.stringify(v)
    return (s ?? String(v)).replace(/\s+/g, " ").slice(0, 200)
}

/** Block timestamps are seconds on older blocks and milliseconds on newer ones. */
export function blockTimeMs(block: any): number | null {
    const raw = Number(block?.content?.timestamp ?? block?.timestamp)
    if (!Number.isFinite(raw) || raw <= 0) return null
    return raw < 1e12 ? raw * 1000 : raw
}

async function openWallet(mnemonic: string, url: string): Promise<Wallet> {
    const demos = new Demos()
    await demos.connect(url)
    await demos.connectWallet(mnemonic, { algorithm: "ed25519" })
    const address = (await demos.getEd25519Address()).toLowerCase()
    const info = await nodeCall(url, "getAddressInfo", { address })
    const nonce = info?.result === 200 && info.response ? Number(info.response.nonce ?? 0) : 0
    return { demos, address, url, nextNonce: nonce + 1, inFlight: 0, busy: false }
}

async function send(w: Wallet, idx: number, txs: LoadTx[], errors: Map<string, number>): Promise<void> {
    w.busy = true
    const rec: LoadTx = { w: idx, nonce: w.nextNonce, sentMs: Date.now(), ok: false, hash: null, includedSeenMs: null, blockNumber: null }
    txs.push(rec)
    try {
        const to = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`
        const signed = await w.demos.pay(to, 1_000_000n, { nonce: w.nextNonce })
        const validity: any = await w.demos.confirm(signed)
        const data = validity?.response?.data
        if (!data?.valid) {
            rec.error = `confirm: ${brief(data?.message ?? validity)}`
        } else {
            const res: any = await w.demos.broadcast(validity)
            if (res?.result === 200) {
                rec.ok = true
                rec.hash = String(data?.transaction?.hash ?? signed.hash).replace(/^0x/, "").toLowerCase()
                w.nextNonce++
                w.inFlight++
            } else {
                rec.error = `broadcast: ${brief(res?.response?.extra ?? res?.extra ?? res?.response ?? res)}`
            }
        }
    } catch (e) {
        rec.error = `threw: ${brief(String(e))}`
    }
    if (rec.error) errors.set(rec.error, (errors.get(rec.error) ?? 0) + 1)
    w.busy = false
}

/** One pass over the accepted, not yet included transfers; returns how many are still open. */
async function follow(txs: LoadTx[], wallets: Wallet[]): Promise<number> {
    const open = txs.filter(t => t.ok && t.includedSeenMs === null)
    const CONCURRENCY = 16
    for (let k = 0; k < open.length; k += CONCURRENCY) {
        await Promise.all(
            open.slice(k, k + CONCURRENCY).map(async t => {
                try {
                    const r = await nodeCall(wallets[t.w].url, "getTransactionStatus", { hash: t.hash }, 5000)
                    if (r?.response?.state === "included") {
                        t.includedSeenMs = Date.now()
                        t.blockNumber = Number(r.response.blockNumber ?? NaN)
                        if (!Number.isSafeInteger(t.blockNumber)) t.blockNumber = null
                        wallets[t.w].inFlight--
                    }
                } catch {
                    // A slow answer is read again on the next pass
                }
            }),
        )
    }
    return open.length - open.filter(t => t.includedSeenMs !== null).length
}

export async function run(): Promise<LoadResult> {
    const urls = (process.env.LOAD_URLS ?? "").split(",").map(s => s.trim()).filter(Boolean)
    if (urls.length === 0) throw new Error("LOAD_URLS is empty")
    const tps = num("LOAD_TPS", 4, 0.01)
    const durationS = num("LOAD_DURATION_S", 300, 1)
    const drainS = num("LOAD_DRAIN_S", 180, 0)
    const window = num("LOAD_WINDOW", 18, 1)
    const dir = process.env.LOAD_WALLET_DIR || "/load"
    const files = readdirSync(dir)
        .filter(f => /^wallet[0-9]+\.identity$/.test(f))
        .sort((a, b) => Number(a.slice(6, -9)) - Number(b.slice(6, -9)))
    if (files.length === 0) throw new Error(`no wallet<j>.identity in ${dir}`)

    const wallets: Wallet[] = []
    for (const [j, f] of files.entries()) {
        wallets.push(await openWallet(readFileSync(join(dir, f), "utf8").trim(), urls[j % urls.length]))
    }
    log(`${wallets.length} wallets over ${urls.length} RPCs, ${tps} TPS for ${durationS}s, window ${window}`)

    const txs: LoadTx[] = []
    const errors = new Map<string, number>()
    let throttled = 0
    let following = true
    const follower = (async () => {
        while (following) {
            const t = Date.now()
            await follow(txs, wallets)
            await sleep(Math.max(0, 1000 - (Date.now() - t)))
        }
    })()

    const tStartMs = Date.now()
    const intervalMs = 1000 / tps
    const total = Math.floor(durationS * tps)
    let next = 0
    for (let k = 0; k < total; k++) {
        await sleep(Math.max(0, tStartMs + k * intervalMs - Date.now()))
        let picked = -1
        for (let a = 0; a < wallets.length; a++) {
            const j = (next + a) % wallets.length
            if (!wallets[j].busy && wallets[j].inFlight < window) {
                picked = j
                break
            }
        }
        if (picked < 0) {
            throttled++
            continue
        }
        next = picked + 1
        void send(wallets[picked], picked, txs, errors)
        if (k > 0 && k % Math.max(1, Math.round(tps * 30)) === 0) {
            const inc = txs.filter(t => t.includedSeenMs !== null).length
            log(`sent ${txs.length}, accepted ${txs.filter(t => t.ok).length}, included ${inc}, throttled ${throttled}`)
        }
    }
    while (wallets.some(w => w.busy)) await sleep(100)
    const tSendEndMs = Date.now()
    log(`sending done: ${txs.length} sent; following for up to ${drainS}s`)

    const drainEnd = Date.now() + drainS * 1000
    while (Date.now() < drainEnd && txs.some(t => t.ok && t.includedSeenMs === null)) await sleep(1000)
    following = false
    await follower
    await follow(txs, wallets)
    const tEndMs = Date.now()

    const blockTimesMs: Record<string, number> = {}
    for (const n of new Set(txs.map(t => t.blockNumber).filter((n): n is number => n !== null))) {
        try {
            const r = await nodeCall(urls[0], "getBlockByNumber", { blockNumber: n })
            const ms = r?.result === 200 ? blockTimeMs(r.response) : null
            if (ms !== null) blockTimesMs[String(n)] = ms
        } catch {
            // The judge reports the transfers whose block time is missing
        }
    }

    const accepted = txs.filter(t => t.ok).length
    return {
        targetTps: tps,
        durationS,
        drainS,
        wallets: wallets.length,
        urls: urls.length,
        window,
        sent: txs.length,
        accepted,
        rejected: txs.length - accepted,
        throttled,
        included: txs.filter(t => t.includedSeenMs !== null).length,
        tStartMs,
        tSendEndMs,
        tEndMs,
        blockTimesMs,
        errors: [...errors.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([message, count]) => ({ message, count })),
        txs,
    }
}

if (import.meta.main) {
    run().then(
        r => {
            log(`done: sent ${r.sent}, accepted ${r.accepted}, included ${r.included}, throttled ${r.throttled}`)
            process.stdout.write(`LOAD_RESULT ${JSON.stringify(r)}\n`)
            process.exit(0)
        },
        e => {
            log(`could not run: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
            process.exit(2)
        },
    )
}
