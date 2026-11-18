/**
 * Verdict and load metrics for the load-* drills run by
 * testing/devnet/quorum-drills/run.sh (scenario_load).
 *
 * run.sh drives load-client.ts against every node's RPC, then writes what the
 * client reported (`load`), the chain's blocks over the window (timestamps
 * from node 1, hash and signature count from every node) and the restart
 * counts to one JSON file. The pass criteria:
 *
 *   L1 load carried: at least one transfer was accepted
 *   L2 included: included / accepted >= limits.minIncludedRatio
 *   L3 no stall: no gap between consecutive blocks of the window, nor from the
 *      last one to the end of the drill, longer than limits.maxGapS
 *   L4 one chain: every node at or past the end height, one hash per height,
 *      every block after the start carries >= q signatures
 *   L5 no crash: no node's container restarted
 *
 * The metrics are the four the team reports for every load run: main TPS,
 * L2PS TPS (not measured here: the drill runs no subnet), block times and
 * time to inclusion (submit to the entry node answering `included`, the
 * transfer's GCR edits applied with its block).
 *
 *   bun testing/forks/rehearsal/lib/judgeLoadDrill.ts <load-input.json> [--out verdict.json]
 *
 * Exit codes: 0 pass, 1 fail, 2 the input could not be read or is malformed.
 */

import { readFileSync, writeFileSync } from "fs"
import { type BlockRow, evaluateNoCrash, evaluateRecovery, signatureQuorum } from "./haltDrill"
import { longestGap, toMs } from "./judgeRestartDrill"

export interface LoadTxRecord {
    w: number
    nonce: number
    sentMs: number
    ok: boolean
    hash: string | null
    error?: string
    includedSeenMs: number | null
    blockNumber: number | null
}

export interface LoadReport {
    targetTps: number
    durationS: number
    wallets: number
    sent: number
    accepted: number
    rejected: number
    throttled: number
    included: number
    tStartMs: number
    tSendEndMs: number
    tEndMs: number
    blockTimesMs: Record<string, number>
    errors: { message: string; count: number }[]
    txs: LoadTxRecord[]
}

export interface LoadInput {
    scenario: string
    validators: number
    shardSize: number
    consensusTimeS: number
    limits: { minIncludedRatio: number; maxGapS: number }
    load: LoadReport
    startHeight: number
    endHeight: number
    tStartMs: number
    tEndMs: number
    blockTimes: { number: number; timestamp: number }[]
    heads: Record<number, number>
    rows: BlockRow[]
    restartCounts: { before: Record<number, number>; after: Record<number, number> }
}

export class LoadInputError extends Error {
    constructor(what: string) {
        super(`load input: ${what}`)
        this.name = "LoadInputError"
    }
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

export function parseLoadInput(raw: unknown): LoadInput {
    const need = (cond: boolean, what: string) => {
        if (!cond) throw new LoadInputError(what)
    }
    need(isObj(raw), "not an object")
    const o = raw as Record<string, unknown>
    need(typeof o.scenario === "string", "scenario must be a string")
    for (const k of ["validators", "shardSize", "consensusTimeS", "startHeight", "endHeight", "tStartMs", "tEndMs"]) {
        need(isNum(o[k]), `${k} must be a number`)
    }
    need(isObj(o.limits) && isNum(o.limits.minIncludedRatio) && isNum(o.limits.maxGapS), "limits needs minIncludedRatio and maxGapS")
    need(isObj(o.load), "load missing")
    const l = o.load as Record<string, unknown>
    for (const k of ["targetTps", "durationS", "sent", "accepted", "included", "tStartMs", "tSendEndMs", "tEndMs"]) {
        need(isNum(l[k]), `load.${k} must be a number`)
    }
    need(isObj(l.blockTimesMs), "load.blockTimesMs must be an object")
    need(Array.isArray(l.txs), "load.txs must be an array")
    for (const [k, t] of (l.txs as unknown[]).entries()) {
        need(isObj(t) && isNum(t.sentMs) && typeof t.ok === "boolean", `load.txs[${k}] needs sentMs and ok`)
        const r = t as Record<string, unknown>
        need(r.includedSeenMs === null || isNum(r.includedSeenMs), `load.txs[${k}].includedSeenMs must be a number or null`)
        need(r.blockNumber === null || isNum(r.blockNumber), `load.txs[${k}].blockNumber must be a number or null`)
    }
    need(Array.isArray(o.blockTimes), "blockTimes must be an array")
    need(Array.isArray(o.rows), "rows must be an array")
    need(isObj(o.heads), "heads missing")
    const rc = o.restartCounts as Record<string, unknown>
    need(isObj(rc) && isObj(rc.before) && isObj(rc.after), "restartCounts missing")
    return raw as LoadInput
}

/** Nearest-rank percentile; null for an empty list. */
export function percentile(values: number[], p: number): number | null {
    if (values.length === 0) return null
    const sorted = [...values].sort((a, b) => a - b)
    const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
    return sorted[Math.min(rank, sorted.length) - 1]
}

const s1 = (ms: number | null) => (ms === null ? null : Math.round(ms / 100) / 10)
const r2 = (v: number) => Math.round(v * 100) / 100

export interface LoadMetrics {
    /** Included transfers per second, from the first send to the last inclusion. */
    mainTps: number
    /** What was offered: sends per second over the send period. */
    offeredTps: number
    targetTps: number
    /** Not measured: the drill runs no L2PS subnet. */
    l2psTps: null
    blockTimeS: { n: number; p50: number | null; p95: number | null; max: number | null }
    /** Submit to the entry node answering `included`. */
    timeToInclusionS: { n: number; p50: number | null; p95: number | null; max: number | null }
    /** Submit to the timestamp of the block that carries the transfer. */
    submitToBlockS: { n: number; p50: number | null; p95: number | null }
    peakTxsPerBlock: number
    includedRatio: number | null
}

export function loadMetrics(input: LoadInput): LoadMetrics {
    const l = input.load
    const included = l.txs.filter(t => t.ok && t.includedSeenMs !== null)
    const landedAt = (t: LoadTxRecord) =>
        (t.blockNumber !== null ? l.blockTimesMs[String(t.blockNumber)] : undefined) ?? (t.includedSeenMs as number)
    const lastLanded = included.length > 0 ? Math.max(...included.map(landedAt)) : null
    const windowS = lastLanded !== null ? (lastLanded - l.tStartMs) / 1000 : 0
    const sendS = (l.tSendEndMs - l.tStartMs) / 1000

    const blocks = input.blockTimes
        .filter(b => b.number >= input.startHeight && b.number <= input.endHeight)
        .sort((a, b) => a.number - b.number)
    const gaps: number[] = []
    for (let k = 1; k < blocks.length; k++) gaps.push(toMs(blocks[k].timestamp) - toMs(blocks[k - 1].timestamp))

    const inclusion = included.map(t => (t.includedSeenMs as number) - t.sentMs)
    const toBlock = included
        .filter(t => t.blockNumber !== null && l.blockTimesMs[String(t.blockNumber)] !== undefined)
        .map(t => l.blockTimesMs[String(t.blockNumber)] - t.sentMs)
    const perBlock = new Map<number, number>()
    for (const t of included) if (t.blockNumber !== null) perBlock.set(t.blockNumber, (perBlock.get(t.blockNumber) ?? 0) + 1)

    return {
        mainTps: windowS > 0 ? r2(included.length / windowS) : 0,
        offeredTps: sendS > 0 ? r2(l.sent / sendS) : 0,
        targetTps: l.targetTps,
        l2psTps: null,
        blockTimeS: { n: gaps.length, p50: s1(percentile(gaps, 50)), p95: s1(percentile(gaps, 95)), max: s1(percentile(gaps, 100)) },
        timeToInclusionS: {
            n: inclusion.length,
            p50: s1(percentile(inclusion, 50)),
            p95: s1(percentile(inclusion, 95)),
            max: s1(percentile(inclusion, 100)),
        },
        submitToBlockS: { n: toBlock.length, p50: s1(percentile(toBlock, 50)), p95: s1(percentile(toBlock, 95)) },
        peakTxsPerBlock: Math.max(0, ...perBlock.values()),
        includedRatio: l.accepted > 0 ? r2(included.length / l.accepted) : null,
    }
}

export interface LoadCheck {
    id: string
    name: string
    pass: boolean
    reasons: string[]
}

export interface LoadVerdict {
    scenario: string
    pass: boolean
    quorum: number
    checks: LoadCheck[]
    metrics: LoadMetrics
    summary: string
}

export function judgeLoad(input: LoadInput): LoadVerdict {
    const nodes = Array.from({ length: input.validators }, (_, i) => i + 1)
    const quorum = signatureQuorum(input.shardSize, input.validators)
    const metrics = loadMetrics(input)
    const l = input.load
    const checks: LoadCheck[] = []
    const check = (id: string, name: string, reasons: string[]) => checks.push({ id, name, pass: reasons.length === 0, reasons })

    const top = l.errors?.[0]
    check("L1", "load carried", l.accepted > 0 ? [] : [`no transfer accepted of ${l.sent} sent${top ? `; most frequent refusal: ${top.message}` : ""}`])
    const included = l.txs.filter(t => t.ok && t.includedSeenMs !== null).length
    check(
        "L2",
        "included",
        l.accepted > 0 && included / l.accepted < input.limits.minIncludedRatio
            ? [`${included}/${l.accepted} accepted transfers included, below ${input.limits.minIncludedRatio}`]
            : [],
    )
    const window = input.blockTimes.filter(b => b.number >= input.startHeight && b.number <= input.endHeight)
    const gap = longestGap(window, input.tEndMs)
    check(
        "L3",
        "no stall",
        gap.gapS > input.limits.maxGapS
            ? [`${gap.gapS}s after block ${gap.afterHeight}${gap.open ? " (to the end of the drill)" : ""} > ${input.limits.maxGapS}s`]
            : [],
    )
    check("L4", "one chain", evaluateRecovery(nodes, input.startHeight, input.endHeight, input.heads, input.rows, quorum).reasons)
    check("L5", "no crash", evaluateNoCrash(input.restartCounts.before, input.restartCounts.after, nodes).reasons)

    const pass = checks.every(c => c.pass)
    const m = metrics
    const summary =
        `mainTps=${m.mainTps} (offered ${m.offeredTps}, target ${m.targetTps}) included=${included}/${l.accepted}/${l.sent} ` +
        `block p50=${m.blockTimeS.p50}s p95=${m.blockTimeS.p95}s max=${m.blockTimeS.max}s ` +
        `inclusion p50=${m.timeToInclusionS.p50}s p95=${m.timeToInclusionS.p95}s ` +
        checks.map(c => `${c.id}=${c.pass ? "ok" : "FAIL"}`).join(" ")
    return { scenario: input.scenario, pass, quorum, checks, metrics, summary }
}

export function formatLoadReport(input: LoadInput, v: LoadVerdict): string[] {
    const m = v.metrics
    const l = input.load
    const lines: string[] = []
    for (const c of v.checks) {
        lines.push(`${c.id} ${c.name}: ${c.pass ? "PASS" : "FAIL"}`)
        for (const r of c.reasons) lines.push(`    - ${r}`)
    }
    lines.push(
        `main TPS: ${m.mainTps} included/s (offered ${m.offeredTps}, target ${m.targetTps}; ${l.wallets} wallets, ${l.throttled} ticks throttled)`,
        "L2PS TPS: not measured (the drill runs no L2PS subnet)",
        `block times: p50 ${m.blockTimeS.p50}s, p95 ${m.blockTimeS.p95}s, max ${m.blockTimeS.max}s (n=${m.blockTimeS.n}, blocks ${input.startHeight}-${input.endHeight})`,
        `time to inclusion: p50 ${m.timeToInclusionS.p50}s, p95 ${m.timeToInclusionS.p95}s, max ${m.timeToInclusionS.max}s (n=${m.timeToInclusionS.n}); ` +
            `submit to block timestamp p50 ${m.submitToBlockS.p50}s, p95 ${m.submitToBlockS.p95}s`,
        `peak transfers in one block: ${m.peakTxsPerBlock}`,
    )
    for (const e of l.errors ?? []) lines.push(`refused x${e.count}: ${e.message}`)
    lines.push(`${v.pass ? "PASS" : "FAIL"}: ${v.scenario} ${v.summary}`, `LOAD_METRICS ${JSON.stringify(m)}`)
    return lines
}

export function main(argv: string[]): number {
    const outIdx = argv.indexOf("--out")
    const out = outIdx >= 0 ? argv[outIdx + 1] : undefined
    const rest = argv.filter((_, i) => outIdx < 0 || (i !== outIdx && i !== outIdx + 1))
    const file = rest.length === 1 && !rest[0].startsWith("--") ? rest[0] : undefined
    if (!file || (outIdx >= 0 && !out)) {
        process.stderr.write("usage: judgeLoadDrill.ts <load-input.json> [--out verdict.json]\n")
        return 2
    }
    let input: LoadInput
    try {
        input = parseLoadInput(JSON.parse(readFileSync(file, "utf8")))
    } catch (e) {
        process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
        return 2
    }
    const v = judgeLoad(input)
    process.stdout.write(`${formatLoadReport(input, v).join("\n")}\n`)
    if (out) writeFileSync(out, `${JSON.stringify(v, null, 2)}\n`)
    return v.pass ? 0 : 1
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
