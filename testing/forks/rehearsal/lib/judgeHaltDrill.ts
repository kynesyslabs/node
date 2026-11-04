/**
 * Verdict for the mainnet-shape quorum-loss drills run by
 * testing/devnet/quorum-drills/run.sh (`halt-n10s10`, `halt-n13s10`,
 * `ride-n13s10`).
 *
 * run.sh stops and starts the containers and writes what it observed to one
 * JSON file (heads, block rows, restart counts, wall-clock marks). This file
 * judges that observation with the same pure functions scenario 12 uses
 * (lib/haltDrill.ts), so the pass criteria are not re-implemented in bash.
 *
 *   bun testing/forks/rehearsal/lib/judgeHaltDrill.ts <input.json> [--out <verdict.json>]
 *
 * Exit codes: 0 pass, 1 fail, 2 the input could not be read or is malformed
 * (no verdict). Prints one line per phase, the timings and a `DRILL_TIMINGS`
 * JSON line, as scenario 12 does.
 *
 * Two modes:
 *  - `halt`: P1 baseline, P2 settle, P3 halt, P4 halt agreement, P5 recovery
 *    and P6 no crash, as in scenario 12.
 *  - `ride`: P1 baseline, R2 ride (the survivors keep forging, every block
 *    carries >= q signatures and one hash) and P6 no crash. Only valid for a
 *    stop count the committee code guarantees the chain tolerates
 *    (`guaranteedTolerance`).
 */

import { readFileSync, writeFileSync } from "fs"
import {
    type BlockRow,
    type DrillMarks,
    type HeightSample,
    type PhaseDurations,
    agreedHeight,
    drillPreconditionError,
    emptyMarks,
    evaluateHalt,
    evaluateNoCrash,
    evaluateRecovery,
    evaluateSettle,
    formatSeconds,
    phaseDurations,
    signatureQuorum,
} from "./haltDrill"

export type DrillMode = "halt" | "ride"

export interface DrillInput {
    scenario: string
    mode: DrillMode
    /** Validators in the devnet; node ids are 1..validators. */
    validators: number
    shardSize: number
    /** Validators stopped at once. */
    stopped: number[]
    consensusTimeS: number
    forks: Record<string, number | null>
    baselineMinHeight: number
    /** Minimum number of hold-window samples (halt mode). */
    holdRounds: number
    marks: DrillMarks
    baseline: { height: number; heads: Record<number, number>; rows: BlockRow[] }
    /** Height all nodes agreed on just before the stop. */
    preStopHeight: number
    /** Identities in the peerlist committed in the pre-stop block. */
    preStopPeerlist: number
    restartCounts: { before: Record<number, number>; after: Record<number, number> }
    /** Halt mode; null when the run ended before that phase. */
    settle: { heads: Record<number, number>; rows: BlockRow[] } | null
    hold: { samples: HeightSample[] } | null
    recovery: { blocks: number; heads: Record<number, number>; rows: BlockRow[] } | null
    /** Ride mode; null when the run ended before that phase. */
    ride: { blocks: number; heads: Record<number, number>; rows: BlockRow[] } | null
}

export class DrillInputError extends Error {
    constructor(public readonly problems: string[]) {
        super(`malformed drill input:\n  - ${problems.join("\n  - ")}`)
        this.name = "DrillInputError"
    }
}

type Problems = string[]

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v)
}

function readInt(v: unknown, path: string, problems: Problems, min = 0): number {
    if (typeof v === "number" && Number.isInteger(v) && v >= min) return v
    problems.push(`${path}: expected an integer >= ${min}, got ${JSON.stringify(v)}`)
    return min
}

function readString(v: unknown, path: string, problems: Problems): string {
    if (typeof v === "string" && v.length > 0) return v
    problems.push(`${path}: expected a non-empty string, got ${JSON.stringify(v)}`)
    return ""
}

function readIntList(v: unknown, path: string, problems: Problems): number[] {
    if (!Array.isArray(v)) {
        problems.push(`${path}: expected an array of node ids`)
        return []
    }
    return v.map((x, i) => readInt(x, `${path}[${i}]`, problems, 1))
}

/** Node id -> integer; -1 is a node that did not answer. */
function readHeads(v: unknown, path: string, problems: Problems): Record<number, number> {
    const out: Record<number, number> = {}
    if (!isRecord(v)) {
        problems.push(`${path}: expected an object of node id -> height`)
        return out
    }
    for (const [k, h] of Object.entries(v)) {
        if (!/^[1-9][0-9]*$/.test(k)) {
            problems.push(`${path}: key ${JSON.stringify(k)} is not a node id`)
            continue
        }
        out[Number(k)] = readInt(h, `${path}.${k}`, problems, -1)
    }
    return out
}

function readRows(v: unknown, path: string, problems: Problems): BlockRow[] {
    if (!Array.isArray(v)) {
        problems.push(`${path}: expected an array of block rows`)
        return []
    }
    return v.map((r, i) => {
        const at = `${path}[${i}]`
        if (!isRecord(r)) {
            problems.push(`${at}: expected an object`)
            return { node: 0, number: 0, hash: "", signatures: 0 }
        }
        return {
            node: readInt(r.node, `${at}.node`, problems, 1),
            number: readInt(r.number, `${at}.number`, problems),
            hash: readString(r.hash, `${at}.hash`, problems),
            signatures: readInt(r.signatures, `${at}.signatures`, problems),
        }
    })
}

function readSamples(v: unknown, path: string, problems: Problems): HeightSample[] {
    if (!Array.isArray(v)) {
        problems.push(`${path}: expected an array of samples`)
        return []
    }
    return v.map((s, i) => {
        const at = `${path}[${i}]`
        if (!isRecord(s)) {
            problems.push(`${at}: expected an object`)
            return { atMs: 0, heights: {} }
        }
        return {
            atMs: readInt(s.atMs, `${at}.atMs`, problems),
            heights: readHeads(s.heights, `${at}.heights`, problems),
        }
    })
}

function readMarks(v: unknown, path: string, problems: Problems): DrillMarks {
    const marks = emptyMarks()
    if (!isRecord(v)) {
        problems.push(`${path}: expected an object of wall-clock marks`)
        return marks
    }
    for (const key of Object.keys(marks) as (keyof DrillMarks)[]) {
        const m = v[key]
        if (m === null) continue
        if (typeof m === "number" && Number.isFinite(m)) marks[key] = m
        else problems.push(`${path}.${key}: expected epoch milliseconds or null, got ${JSON.stringify(m)}`)
    }
    return marks
}

function readForks(v: unknown, path: string, problems: Problems): Record<string, number | null> {
    const out: Record<string, number | null> = {}
    if (!isRecord(v)) {
        problems.push(`${path}: expected an object of fork name -> activation height`)
        return out
    }
    for (const [name, h] of Object.entries(v)) {
        out[name] = h === null ? null : readInt(h, `${path}.${name}`, problems)
    }
    return out
}

/** A phase object, or null when the run ended before it. */
function readPhase<T>(
    v: unknown,
    path: string,
    problems: Problems,
    read: (o: Record<string, unknown>) => T,
): T | null {
    if (v === null || v === undefined) return null
    if (!isRecord(v)) {
        problems.push(`${path}: expected an object or null`)
        return null
    }
    return read(v)
}

/** Validates the JSON run.sh wrote. Throws `DrillInputError` listing every problem. */
export function parseDrillInput(raw: unknown): DrillInput {
    const problems: Problems = []
    if (!isRecord(raw)) throw new DrillInputError(["the input is not a JSON object"])

    const mode = raw.mode
    if (mode !== "halt" && mode !== "ride") {
        problems.push(`mode: expected "halt" or "ride", got ${JSON.stringify(mode)}`)
    }
    const validators = readInt(raw.validators, "validators", problems, 1)
    const stopped = readIntList(raw.stopped, "stopped", problems)
    if (stopped.length === 0) problems.push("stopped: no validator is stopped")
    if (new Set(stopped).size !== stopped.length) problems.push("stopped: duplicate node ids")
    for (const id of stopped) {
        if (id > validators) problems.push(`stopped: node-${id} is not among the ${validators} validators`)
    }

    const baseline = isRecord(raw.baseline) ? raw.baseline : {}
    if (!isRecord(raw.baseline)) problems.push("baseline: expected an object")
    const counts = isRecord(raw.restartCounts) ? raw.restartCounts : {}
    if (!isRecord(raw.restartCounts)) problems.push("restartCounts: expected an object")

    const input: DrillInput = {
        scenario: readString(raw.scenario, "scenario", problems),
        mode: mode === "ride" ? "ride" : "halt",
        validators,
        shardSize: readInt(raw.shardSize, "shardSize", problems, 1),
        stopped,
        consensusTimeS: readInt(raw.consensusTimeS, "consensusTimeS", problems, 1),
        forks: readForks(raw.forks, "forks", problems),
        baselineMinHeight: readInt(raw.baselineMinHeight, "baselineMinHeight", problems),
        holdRounds: readInt(raw.holdRounds, "holdRounds", problems),
        marks: readMarks(raw.marks, "marks", problems),
        baseline: {
            height: readInt(baseline.height, "baseline.height", problems),
            heads: readHeads(baseline.heads, "baseline.heads", problems),
            rows: readRows(baseline.rows, "baseline.rows", problems),
        },
        preStopHeight: readInt(raw.preStopHeight, "preStopHeight", problems),
        preStopPeerlist: readInt(raw.preStopPeerlist, "preStopPeerlist", problems),
        restartCounts: {
            before: readHeads(counts.before, "restartCounts.before", problems),
            after: readHeads(counts.after, "restartCounts.after", problems),
        },
        settle: readPhase(raw.settle, "settle", problems, o => ({
            heads: readHeads(o.heads, "settle.heads", problems),
            rows: readRows(o.rows, "settle.rows", problems),
        })),
        hold: readPhase(raw.hold, "hold", problems, o => ({
            samples: readSamples(o.samples, "hold.samples", problems),
        })),
        recovery: readPhase(raw.recovery, "recovery", problems, o => ({
            blocks: readInt(o.blocks, "recovery.blocks", problems, 1),
            heads: readHeads(o.heads, "recovery.heads", problems),
            rows: readRows(o.rows, "recovery.rows", problems),
        })),
        ride: readPhase(raw.ride, "ride", problems, o => ({
            blocks: readInt(o.blocks, "ride.blocks", problems, 1),
            heads: readHeads(o.heads, "ride.heads", problems),
            rows: readRows(o.rows, "ride.rows", problems),
        })),
    }
    if (problems.length > 0) throw new DrillInputError(problems)
    return input
}

/**
 * Validators that may be down at once while every bound-committee draw still
 * holds the signatures a block needs.
 *
 * Under committeeBinding the committee is `min(shardSize, pool)` identities
 * drawn from chain data alone, and an offline member is not replaced
 * (getShard.ts, `getBoundCommittee`, `liveBoundMembers`). Only its members'
 * signatures count, and a block needs `signatureQuorum` of them. The worst
 * draw puts every down validator in the committee, so the committee keeps
 * `min(shardSize, pool) - down` live members, which must stay at or above the
 * quorum. Holds only while the pool the committee is drawn from has at least
 * `shardSize` identities (see `ridePreconditionError`).
 */
export function guaranteedTolerance(shardSize: number, poolSize: number): number {
    return Math.min(shardSize, poolSize) - signatureQuorum(shardSize, poolSize)
}

/** Null when the ride drill is meaningful, otherwise why not. */
export function ridePreconditionError(
    shardSize: number,
    poolSize: number,
    stopped: number,
    preStopPeerlist: number,
): string | null {
    const tolerance = guaranteedTolerance(shardSize, poolSize)
    if (stopped > tolerance) {
        return (
            `${stopped} stopped exceeds the ${tolerance} the committee code guarantees ` +
            `(shardSize ${shardSize}, ${poolSize} validators): whether the chain forges would depend on the draw`
        )
    }
    const committee = Math.min(shardSize, poolSize)
    if (preStopPeerlist < committee) {
        return (
            `the pre-stop block lists ${preStopPeerlist} validators, fewer than the committee of ${committee}: ` +
            "a committee drawn from that pool can hold more down validators than the tolerance covers"
        )
    }
    return null
}

export interface PhaseResult {
    id: string
    name: string
    pass: boolean
    reasons: string[]
}

export interface DrillVerdict {
    scenario: string
    mode: DrillMode
    pass: boolean
    quorum: number
    survivors: number[]
    stopped: number[]
    preStopHeight: number
    haltHeight: number | null
    targetHeight: number | null
    settleBlocks: number | null
    phases: PhaseResult[]
    durationsMs: PhaseDurations
    /** Ride mode only: marks relative to the stop. */
    rideMs: { stopToFirstNewBlockMs: number | null; stopToTargetMs: number | null } | null
    /** One line for results.tsv. */
    summary: string
}

function phase(id: string, name: string, reasons: string[]): PhaseResult {
    return { id, name, pass: reasons.length === 0, reasons }
}

const NOT_REACHED = "not reached: the run ended before this phase"

/**
 * Hashes agree at one height on `nodes`: scenario 12's recovery check with the
 * pre-stop and target heights both at `height`, so only head, storage and hash
 * agreement apply and no signature bar does.
 */
function agreementAt(
    nodes: number[],
    height: number,
    heads: Record<number, number>,
    rows: BlockRow[],
    quorum: number,
): string[] {
    return evaluateRecovery(nodes, height, height, heads, rows, quorum).reasons
}

function span(from: number | null, to: number | null): number | null {
    return from === null || to === null ? null : to - from
}

/** Applies the drill's pass criteria to what run.sh observed. */
export function judgeDrill(input: DrillInput): DrillVerdict {
    const nodes = Array.from({ length: input.validators }, (_, i) => i + 1)
    const survivors = nodes.filter(id => !input.stopped.includes(id))
    const quorum = signatureQuorum(input.shardSize, input.validators)
    const phases: PhaseResult[] = []
    const heights = {
        haltHeight: null as number | null,
        targetHeight: null as number | null,
        settleBlocks: null as number | null,
    }

    const verdict = (): DrillVerdict => {
        const pass = phases.every(p => p.pass)
        const summary =
            `pre=${input.preStopHeight} ` +
            (heights.haltHeight !== null ? `halt=${heights.haltHeight} ` : "") +
            (heights.targetHeight !== null ? `target=${heights.targetHeight} ` : "") +
            phases.map(p => `${p.id}=${p.pass ? "ok" : "FAIL"}`).join(" ")
        return {
            scenario: input.scenario,
            mode: input.mode,
            pass,
            quorum,
            survivors,
            stopped: input.stopped,
            preStopHeight: input.preStopHeight,
            ...heights,
            phases,
            durationsMs: phaseDurations(input.marks),
            rideMs:
                input.mode === "ride"
                    ? {
                          stopToFirstNewBlockMs: span(input.marks.t_stop, input.marks.t_first_new_block),
                          stopToTargetMs: span(input.marks.t_stop, input.marks.t_converged),
                      }
                    : null,
            summary,
        }
    }

    const precondition =
        input.mode === "halt"
            ? drillPreconditionError(input.shardSize, input.validators, survivors.length)
            : ridePreconditionError(
                  input.shardSize,
                  input.validators,
                  input.stopped.length,
                  input.preStopPeerlist,
              )
    if (precondition) {
        phases.push(phase("P0", "precondition", [precondition]))
        return verdict()
    }

    // P1 baseline
    const baselineReasons = agreementAt(
        nodes,
        input.baseline.height,
        input.baseline.heads,
        input.baseline.rows,
        quorum,
    )
    if (input.baseline.height < input.baselineMinHeight) {
        baselineReasons.push(
            `baseline height ${input.baseline.height} < required ${input.baselineMinHeight}`,
        )
    }
    phases.push(phase("P1", "baseline", baselineReasons))

    const crash = () => {
        const noCrash = evaluateNoCrash(
            input.restartCounts.before,
            input.restartCounts.after,
            survivors,
        )
        phases.push(phase("P6", "no crash", noCrash.reasons))
    }

    if (input.mode === "ride") {
        const ride = input.ride
        if (ride === null) {
            phases.push(phase("R2", "ride", [NOT_REACHED]))
        } else {
            heights.targetHeight = input.preStopHeight + ride.blocks
            const r = evaluateRecovery(
                survivors,
                input.preStopHeight,
                heights.targetHeight,
                ride.heads,
                ride.rows,
                quorum,
            )
            phases.push(phase("R2", "ride", r.reasons))
        }
        crash()
        return verdict()
    }

    // P2 settle
    const settle = input.settle
    if (settle === null) {
        phases.push(phase("P2", "settle", [NOT_REACHED]))
    } else {
        heights.haltHeight = agreedHeight(survivors, settle.heads)
        if (heights.haltHeight === null) {
            phases.push(
                phase("P2", "settle", [
                    `survivors did not agree on a head after settle: ${JSON.stringify(settle.heads)}`,
                ]),
            )
        } else {
            heights.settleBlocks = heights.haltHeight - input.preStopHeight
            const s = evaluateSettle(
                survivors,
                input.preStopHeight,
                heights.haltHeight,
                settle.rows,
                quorum,
            )
            phases.push(phase("P2", "settle", s.reasons))
        }
    }
    const haltHeight = heights.haltHeight

    // P3 halt
    if (haltHeight === null || input.hold === null) {
        phases.push(phase("P3", "halt", [haltHeight === null ? "no halt height" : NOT_REACHED]))
    } else {
        phases.push(
            phase(
                "P3",
                "halt",
                evaluateHalt(survivors, haltHeight, input.hold.samples, input.holdRounds).reasons,
            ),
        )
    }

    // P4 halt agreement
    if (haltHeight === null || settle === null) {
        phases.push(phase("P4", "halt agreement", ["no halt height"]))
    } else {
        phases.push(
            phase(
                "P4",
                "halt agreement",
                agreementAt(survivors, haltHeight, settle.heads, settle.rows, quorum),
            ),
        )
    }

    // P5 recovery
    if (haltHeight === null || input.recovery === null) {
        phases.push(phase("P5", "recovery", [haltHeight === null ? "no halt height" : NOT_REACHED]))
    } else {
        heights.targetHeight = haltHeight + input.recovery.blocks
        const r = evaluateRecovery(
            nodes,
            input.preStopHeight,
            heights.targetHeight,
            input.recovery.heads,
            input.recovery.rows,
            quorum,
        )
        phases.push(phase("P5", "recovery", r.reasons))
    }

    crash()
    return verdict()
}

function iso(ms: number | null): string | null {
    return ms === null ? null : new Date(ms).toISOString()
}

/** The `DRILL_TIMINGS` payload: scenario 12's shape plus the validator counts. */
export function timingsLine(input: DrillInput, verdict: DrillVerdict): Record<string, unknown> {
    return {
        scenario: input.scenario,
        marks: Object.fromEntries(Object.entries(input.marks).map(([k, v]) => [k, iso(v as number | null)])),
        durationsMs: verdict.durationsMs,
        ...(verdict.rideMs ? { rideMs: verdict.rideMs } : {}),
        preStopHeight: verdict.preStopHeight,
        haltHeight: verdict.haltHeight,
        targetHeight: verdict.targetHeight,
        settleBlocks: verdict.settleBlocks,
        consensusTimeS: input.consensusTimeS,
        shardSize: input.shardSize,
        validators: input.validators,
        stopped: input.stopped,
        forks: input.forks,
    }
}

/** Human-readable report, one entry per line. */
export function formatReport(input: DrillInput, verdict: DrillVerdict): string[] {
    const d = verdict.durationsMs
    const lines: string[] = []
    for (const p of verdict.phases) {
        lines.push(`${p.id} ${p.name}: ${p.pass ? "PASS" : "FAIL"}`)
        for (const r of p.reasons) lines.push(`    - ${r}`)
    }
    lines.push(`timing: cold start to baseline ${formatSeconds(d.coldStartToBaselineMs)}`)
    if (verdict.rideMs) {
        lines.push(
            `timing: stop to first new block ${formatSeconds(verdict.rideMs.stopToFirstNewBlockMs)}`,
            `timing: stop to survivors at target ${formatSeconds(verdict.rideMs.stopToTargetMs)}`,
        )
    } else {
        lines.push(
            `timing: stop to halt confirmed ${formatSeconds(d.stopToHaltConfirmedMs)}`,
            `timing: halt hold ${formatSeconds(d.haltHoldMs)}`,
            `timing: restart to first new block ${formatSeconds(d.restartToFirstNewBlockMs)}`,
            `timing: restart to all ${input.validators} converged ${formatSeconds(d.restartToConvergedMs)}`,
        )
    }
    lines.push(
        `timing: total ${formatSeconds(d.totalMs)} (all validators serving to the last mark)`,
        `heights: pre-stop ${verdict.preStopHeight}, halt ${verdict.haltHeight ?? "n/a"}, ` +
            `target ${verdict.targetHeight ?? "n/a"}, ${verdict.settleBlocks ?? "n/a"} block(s) landed during settle`,
        `config: CONSENSUS_TIME ${input.consensusTimeS}s, ${input.validators} validators, shardSize ${input.shardSize}, ` +
            `quorum ${verdict.quorum}, stopped [${input.stopped.join(",")}], ` +
            `forks ${Object.entries(input.forks).map(([n, h]) => `${n}@${h}`).join(", ")}`,
        `${verdict.pass ? "PASS" : "FAIL"}: ${verdict.scenario} ${verdict.summary}`,
        `DRILL_TIMINGS ${JSON.stringify(timingsLine(input, verdict))}`,
    )
    return lines
}

/** CLI. Returns the process exit code. */
export function main(argv: string[]): number {
    const outIdx = argv.indexOf("--out")
    const out = outIdx >= 0 ? argv[outIdx + 1] : undefined
    const rest = argv.filter((_, i) => outIdx < 0 || (i !== outIdx && i !== outIdx + 1))
    const file = rest.length === 1 && !rest[0].startsWith("--") ? rest[0] : undefined
    if (!file || (outIdx >= 0 && !out)) {
        process.stderr.write("usage: judgeHaltDrill.ts <input.json> [--out <verdict.json>]\n")
        return 2
    }
    let input: DrillInput
    try {
        input = parseDrillInput(JSON.parse(readFileSync(file, "utf8")))
    } catch (e) {
        process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
        return 2
    }
    const verdict = judgeDrill(input)
    process.stdout.write(`${formatReport(input, verdict).join("\n")}\n`)
    if (out) {
        writeFileSync(out, `${JSON.stringify({ ...verdict, timings: timingsLine(input, verdict) }, null, 2)}\n`)
    }
    return verdict.pass ? 0 : 1
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
