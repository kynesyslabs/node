/**
 * Judge of the `restart-*` quorum drill (testing/devnet/quorum-drills/run.sh):
 * one validator at a time is restarted at a random point of a round it is a
 * committee member of, several times, and each must be back signing at once.
 *
 *   bun testing/forks/rehearsal/lib/judgeRestartDrill.ts <restart-input.json> [--out verdict.json]
 *
 * Exit 0 pass, 1 fail, 2 the input cannot be read.
 *
 * What a restarted validator may do, from src/libs/consensus/v2: it refuses to
 * sign any round at or below its restart signing floor, so the round in flight
 * when it comes back may go without its vote. The next round it is drawn for
 * must carry its precommit. A validator that waits out a green light it will
 * never get (the 60 s secretary timeout) instead of joining the next round
 * misses round after round, and with too few others live the chain stops
 * until it is restarted a second time; that is what each cycle checks.
 *
 * Per cycle:
 *  - boot: the victim serves its RPC within limits.bootS of the restart;
 *  - sync: it holds the head the network had when it came back within
 *    limits.syncS of serving;
 *  - signing: of the heights it is drawn for after the restart, the first or
 *    the second has its precommit, logged within limits.roundS of that
 *    round's start, and that round starts within limits.drawS of serving;
 *  - one restart: its restart count does not move from serving to the end.
 * Over the drill:
 *  - no stall: no gap between consecutive blocks, nor from the last block to
 *    the end, longer than limits.maxGapS;
 *  - one chain: every node holds every height of the drill with one hash, and
 *    every block has quorum signatures (evaluateRecovery);
 *  - no crash: the restart counts of the validators never restarted do not move.
 */

import { readFileSync, writeFileSync } from "fs"
import { evaluateNoCrash, evaluateRecovery, signatureQuorum, type BlockRow } from "./haltDrill"

export interface RestartLimits {
    bootS: number
    syncS: number
    roundS: number
    drawS: number
    maxGapS: number
}

export interface RestartCycle {
    victim: number
    tRestartMs: number
    tServingMs: number | null
    /** Network head when the victim served again. */
    servingHead: number | null
    tSyncedMs: number | null
    restartCountServing: number | null
    restartCountEnd: number | null
    /** The victim's log lines since the restart, `docker logs --timestamps`. */
    log: string[]
}

export interface RestartInput {
    scenario: string
    validators: number
    shardSize: number
    consensusTimeS: number
    limits: RestartLimits
    cycles: RestartCycle[]
    startHeight: number
    endHeight: number
    tEndMs: number
    /** Block timestamps of startHeight..endHeight (s or ms, as the producer wrote them). */
    blockTimes: { number: number; timestamp: number }[]
    heads: Record<number, number>
    rows: BlockRow[]
    restartCounts: { before: Record<number, number>; after: Record<number, number> }
}

export class RestartInputError extends Error {}

/** A height the victim was drawn for: its first round start and its precommit, if any. */
export interface CommitteeRound {
    height: number
    startMs: number
    precommitMs: number | null
}

export interface VictimLog {
    rounds: CommitteeRound[]
    greenLightTimeouts: number
    signingFloor: string | null
}

const TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s/
const FORGING = /We are forging block (\d+)/
const PRECOMMIT = /\[commitLock\] Precommit tally for block /
const GREEN_LIGHT_TIMEOUT = /Timeout waiting for green light/
const FLOOR = /Restart signing floor: (.*)$/

function tsMs(line: string): number | null {
    const m = TS.exec(line)
    if (!m) return null
    // Date.parse keeps milliseconds only: drop the rest of the fraction first
    const iso = m[1].replace(/(\.\d{3})\d*Z$/, "$1Z")
    const ms = Date.parse(iso)
    return Number.isFinite(ms) ? ms : null
}

/**
 * The victim's committee rounds from its log. "We are forging block B" is
 * logged by committee members of B only (secretaryManager), once per attempt,
 * so the first one of a height opens it. A precommit tally belongs to the
 * height opened last before it.
 */
export function parseVictimLog(lines: string[]): VictimLog {
    const rounds: CommitteeRound[] = []
    const byHeight = new Map<number, CommitteeRound>()
    let current: CommitteeRound | null = null
    let greenLightTimeouts = 0
    let signingFloor: string | null = null
    for (const line of lines) {
        const at = tsMs(line)
        if (at === null) continue
        const f = FORGING.exec(line)
        if (f) {
            const height = Number(f[1])
            let r = byHeight.get(height)
            if (!r) {
                r = { height, startMs: at, precommitMs: null }
                byHeight.set(height, r)
                rounds.push(r)
            }
            current = r
            continue
        }
        if (PRECOMMIT.test(line)) {
            if (current && current.precommitMs === null) current.precommitMs = at
            continue
        }
        if (GREEN_LIGHT_TIMEOUT.test(line)) greenLightTimeouts++
        const fl = FLOOR.exec(line)
        if (fl) signingFloor = fl[1].trim()
    }
    rounds.sort((a, b) => a.height - b.height)
    return { rounds, greenLightTimeouts, signingFloor }
}

export interface CycleResult {
    victim: number
    pass: boolean
    reasons: string[]
    bootS: number | null
    syncS: number | null
    /** Which committee round after the restart carried its precommit (1-based), null if none. */
    signedRound: number | null
    /** Seconds from serving to that precommit. */
    signedAfterS: number | null
    roundsDrawn: number
    greenLightTimeouts: number
    signingFloor: string | null
}

const secs = (ms: number) => Math.round(ms / 100) / 10

export function judgeCycle(c: RestartCycle, limits: RestartLimits): CycleResult {
    const reasons: string[] = []
    const log = parseVictimLog(c.log)
    const bootS = c.tServingMs === null ? null : secs(c.tServingMs - c.tRestartMs)
    const syncS = c.tServingMs === null || c.tSyncedMs === null ? null : secs(c.tSyncedMs - c.tServingMs)
    if (bootS === null) reasons.push(`node-${c.victim} never served after the restart`)
    else if (bootS > limits.bootS) reasons.push(`node-${c.victim} served ${bootS}s after the restart (> ${limits.bootS}s)`)
    if (c.tServingMs !== null) {
        if (syncS === null) reasons.push(`node-${c.victim} never reached head ${c.servingHead ?? "?"} after serving`)
        else if (syncS > limits.syncS) reasons.push(`node-${c.victim} reached head ${c.servingHead} ${syncS}s after serving (> ${limits.syncS}s)`)
    }
    // Only rounds opened after the restart: the log may begin a little before it
    const rounds = log.rounds.filter(r => r.startMs >= c.tRestartMs)
    let signedRound: number | null = null
    let signedAfterS: number | null = null
    for (let k = 0; k < rounds.length; k++) {
        if (rounds[k].precommitMs !== null) {
            signedRound = k + 1
            signedAfterS = c.tServingMs === null ? null : secs((rounds[k].precommitMs as number) - c.tServingMs)
            break
        }
    }
    const ref = c.tServingMs ?? c.tRestartMs
    if (rounds.length === 0) {
        reasons.push(`node-${c.victim} was not drawn for any committee in the window after the restart`)
    } else if (signedRound === null || signedRound > 2) {
        const which = rounds.slice(0, 2).map(r => r.height).join(" and ")
        reasons.push(
            `node-${c.victim} did not sign at its first committee heights after the restart (${which})` +
                (signedRound === null ? "" : `; first precommit at its round ${signedRound}`) +
                (log.greenLightTimeouts ? `; ${log.greenLightTimeouts} green-light timeout(s)` : ""),
        )
    } else {
        const r = rounds[signedRound - 1]
        const took = secs((r.precommitMs as number) - r.startMs)
        if (took > limits.roundS) {
            reasons.push(`node-${c.victim} signed height ${r.height} ${took}s after the round started (> ${limits.roundS}s)`)
        }
        const late = secs(r.startMs - ref)
        if (late > limits.drawS) {
            reasons.push(`node-${c.victim}'s signed round ${r.height} started ${late}s after it served (> ${limits.drawS}s)`)
        }
    }
    if (c.restartCountServing === null || c.restartCountEnd === null) {
        reasons.push(`node-${c.victim}: restart count not read`)
    } else if (c.restartCountEnd !== c.restartCountServing) {
        reasons.push(`node-${c.victim} restarted again on its own (count ${c.restartCountServing} -> ${c.restartCountEnd})`)
    }
    return {
        victim: c.victim,
        pass: reasons.length === 0,
        reasons,
        bootS,
        syncS,
        signedRound,
        signedAfterS,
        roundsDrawn: rounds.length,
        greenLightTimeouts: log.greenLightTimeouts,
        signingFloor: log.signingFloor,
    }
}

/** Block timestamps in ms, whichever unit the producer wrote. */
export function toMs(ts: number): number {
    return ts > 100_000_000_000 ? ts : ts * 1000
}

/** The longest gap (s) between consecutive blocks of the drill, and from the last one to its end. */
export function longestGap(
    blockTimes: { number: number; timestamp: number }[],
    tEndMs: number,
): { gapS: number; afterHeight: number | null; open: boolean } {
    const sorted = [...blockTimes].sort((a, b) => a.number - b.number)
    let gap = 0
    let after: number | null = null
    let open = false
    for (let k = 1; k < sorted.length; k++) {
        const d = toMs(sorted[k].timestamp) - toMs(sorted[k - 1].timestamp)
        if (d > gap) {
            gap = d
            after = sorted[k - 1].number
        }
    }
    if (sorted.length > 0) {
        const last = sorted[sorted.length - 1]
        const d = tEndMs - toMs(last.timestamp)
        if (d > gap) {
            gap = d
            after = last.number
            open = true
        }
    }
    return { gapS: secs(gap), afterHeight: after, open }
}

export interface RestartVerdict {
    pass: boolean
    summary: string
    cycles: CycleResult[]
    gap: { pass: boolean; gapS: number; afterHeight: number | null; open: boolean; limitS: number }
    chain: { pass: boolean; reasons: string[] }
    noCrash: { pass: boolean; reasons: string[] }
}

export function judgeRestart(input: RestartInput): RestartVerdict {
    const cycles = input.cycles.map(c => judgeCycle(c, input.limits))
    const g = longestGap(input.blockTimes, input.tEndMs)
    const gap = { ...g, pass: g.gapS <= input.limits.maxGapS, limitS: input.limits.maxGapS }
    const nodes = Array.from({ length: input.validators }, (_, k) => k + 1)
    const chain = evaluateRecovery(
        nodes,
        input.startHeight,
        input.endHeight,
        input.heads,
        input.rows,
        signatureQuorum(input.shardSize, input.validators),
    )
    if (input.endHeight <= input.startHeight) {
        chain.reasons.push(`the chain did not move over the drill (${input.startHeight} -> ${input.endHeight})`)
        chain.pass = false
    }
    const victims = new Set(input.cycles.map(c => c.victim))
    const others = nodes.filter(n => !victims.has(n))
    const noCrash = evaluateNoCrash(input.restartCounts.before, input.restartCounts.after, others)
    const pass = cycles.every(c => c.pass) && gap.pass && chain.pass && noCrash.pass
    const perCycle = cycles
        .map(c => `n${c.victim}:${c.pass ? "ok" : "FAIL"}(boot ${c.bootS ?? "-"}s, signed r${c.signedRound ?? "-"} +${c.signedAfterS ?? "-"}s)`)
        .join(" ")
    const summary =
        `${pass ? "PASS" : "FAIL"} restarts=${cycles.length} ${perCycle} ` +
        `maxGap=${gap.gapS}s/${gap.limitS}s${gap.open ? "(open)" : ""} ` +
        `blocks ${input.startHeight}->${input.endHeight} chain=${chain.pass ? "ok" : "FAIL"} noCrash=${noCrash.pass ? "ok" : "FAIL"}`
    return { pass, summary, cycles, gap, chain, noCrash }
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const numOrNull = (v: unknown): v is number | null => v === null || isNum(v)

export function parseRestartInput(raw: unknown): RestartInput {
    const o = raw as Record<string, unknown>
    const need = (cond: boolean, what: string) => {
        if (!cond) throw new RestartInputError(`restart input: ${what}`)
    }
    need(typeof o === "object" && o !== null, "not an object")
    for (const k of ["validators", "shardSize", "consensusTimeS", "startHeight", "endHeight", "tEndMs"]) {
        need(isNum(o[k]), `${k} must be a number`)
    }
    const l = o.limits as Record<string, unknown>
    need(typeof l === "object" && l !== null, "limits missing")
    for (const k of ["bootS", "syncS", "roundS", "drawS", "maxGapS"]) need(isNum(l[k]), `limits.${k} must be a number`)
    need(Array.isArray(o.cycles) && (o.cycles as unknown[]).length > 0, "cycles must be a non-empty array")
    for (const [k, c] of (o.cycles as Record<string, unknown>[]).entries()) {
        need(isNum(c.victim) && isNum(c.tRestartMs), `cycles[${k}] needs victim and tRestartMs`)
        for (const f of ["tServingMs", "servingHead", "tSyncedMs", "restartCountServing", "restartCountEnd"]) {
            need(numOrNull(c[f]), `cycles[${k}].${f} must be a number or null`)
        }
        need(Array.isArray(c.log) && (c.log as unknown[]).every(s => typeof s === "string"), `cycles[${k}].log must be strings`)
    }
    need(Array.isArray(o.blockTimes), "blockTimes must be an array")
    need(Array.isArray(o.rows), "rows must be an array")
    need(typeof o.heads === "object" && o.heads !== null, "heads missing")
    const rc = o.restartCounts as Record<string, unknown>
    need(typeof rc === "object" && rc !== null && typeof rc.before === "object" && typeof rc.after === "object", "restartCounts missing")
    return raw as RestartInput
}

export function main(argv: string[]): number {
    const file = argv[0]
    const outIdx = argv.indexOf("--out")
    const out = outIdx >= 0 ? argv[outIdx + 1] : undefined
    if (!file || file.startsWith("--") || (outIdx >= 0 && !out)) {
        process.stderr.write("usage: judgeRestartDrill.ts <restart-input.json> [--out verdict.json]\n")
        return 2
    }
    let input: RestartInput
    try {
        input = parseRestartInput(JSON.parse(readFileSync(file, "utf8")))
    } catch (e) {
        process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
        return 2
    }
    const v = judgeRestart(input)
    const lines = [`[restart-judge] ${v.summary}`]
    for (const c of v.cycles) for (const r of c.reasons) lines.push(`  cycle node-${c.victim}: ${r}`)
    if (!v.gap.pass) lines.push(`  stall: ${v.gap.gapS}s after block ${v.gap.afterHeight}${v.gap.open ? " (to the end of the drill)" : ""} > ${v.gap.limitS}s`)
    for (const r of v.chain.reasons) lines.push(`  chain: ${r}`)
    for (const r of v.noCrash.reasons) lines.push(`  crash: ${r}`)
    process.stdout.write(lines.join("\n") + "\n")
    if (out) writeFileSync(out, JSON.stringify(v, null, 2) + "\n")
    return v.pass ? 0 : 1
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
