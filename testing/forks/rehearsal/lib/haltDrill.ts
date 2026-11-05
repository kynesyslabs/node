/**
 * Pass criteria for the quorum-loss drill (scenario 11), kept free of
 * docker and network calls so they can be unit tested.
 *
 * Quorum arithmetic mirrors the node: verifyBlock requires
 * floor(2 * min(shardSize, pool) / 3) + 1 signatures, and getShard /
 * SecretaryManager refuse to forge below floor(2 * shardSize / 3) + 1
 * committee members.
 */

/** Signatures a block needs: floor(2 * min(shardSize, pool) / 3) + 1. */
export function signatureQuorum(shardSize: number, poolSize: number): number {
    const denominator = Math.min(shardSize, poolSize)
    return Math.floor((denominator * 2) / 3) + 1
}

/** Committee floor below which no node forges: floor(2 * shardSize / 3) + 1. */
export function committeeFloor(shardSize: number): number {
    return Math.floor((shardSize * 2) / 3) + 1
}

/**
 * The drill only means something when the full set can forge and the
 * survivors cannot. Returns null when the setup is meaningful, otherwise
 * the reason it is not.
 */
export function drillPreconditionError(
    shardSize: number,
    poolSize: number,
    survivors: number,
): string | null {
    const floor = committeeFloor(shardSize)
    if (poolSize < floor) {
        return (
            `shardSize=${shardSize} gives a committee floor of ${floor}, above the ` +
            `${poolSize}-validator pool: the full devnet cannot forge at all`
        )
    }
    if (survivors >= floor && survivors >= signatureQuorum(shardSize, poolSize)) {
        return (
            `${survivors} survivors still meet quorum (floor ${floor}): ` +
            "stopping them would not halt the chain"
        )
    }
    return null
}

export interface HeightSample {
    /** Milliseconds since the drill started. */
    atMs: number
    /** node id -> head height, or -1 when the RPC did not answer. */
    heights: Record<number, number>
}

export interface Verdict {
    pass: boolean
    reasons: string[]
}

/**
 * Returns the height every listed node reports, or null when a node did
 * not answer or the nodes disagree.
 */
export function agreedHeight(
    nodes: number[],
    heads: Record<number, number>,
): number | null {
    const hs = nodes.map(id => heads[id])
    if (hs.some(h => h === undefined || h < 0)) return null
    return hs.every(h => h === hs[0]) ? hs[0] : null
}

/**
 * Halt criteria, evaluated over the samples taken after the settle
 * period: every survivor answers every sample, and every survivor's head
 * stays exactly at `haltHeight` (the height the survivors agreed on once
 * the settle period ended). A head above it means a block was produced
 * without quorum; a head below it means a survivor lost blocks.
 */
export function evaluateHalt(
    survivors: number[],
    haltHeight: number,
    samples: HeightSample[],
    minSamples: number,
): Verdict {
    const reasons: string[] = []
    if (samples.length < minSamples) {
        reasons.push(`only ${samples.length} samples, need ${minSamples}`)
    }
    for (const s of samples) {
        for (const id of survivors) {
            const h = s.heights[id]
            if (h === undefined || h < 0) {
                reasons.push(`node-${id} did not answer at +${s.atMs}ms`)
            } else if (h > haltHeight) {
                reasons.push(
                    `node-${id} advanced to ${h} > halt height ${haltHeight} at +${s.atMs}ms ` +
                        "(a block was produced without quorum)",
                )
            } else if (h < haltHeight) {
                reasons.push(
                    `node-${id} went back to ${h} < halt height ${haltHeight} at +${s.atMs}ms`,
                )
            }
        }
    }
    return { pass: reasons.length === 0, reasons }
}

export interface BlockRow {
    node: number
    number: number
    hash: string
    signatures: number
}

/**
 * Settle criteria. Blocks that land between the stop and the halt height
 * (`preStopHeight` < number <= `haltHeight`) are legitimate only if they
 * were already in flight with enough signatures: every such block must
 * be stored by every survivor with one hash and carry at least `quorum`
 * signatures. A block committed by the survivors alone fails here.
 */
export function evaluateSettle(
    survivors: number[],
    preStopHeight: number,
    haltHeight: number,
    rows: BlockRow[],
    quorum: number,
): Verdict {
    const reasons: string[] = []
    if (haltHeight < preStopHeight) {
        reasons.push(`halt height ${haltHeight} is below the pre-stop height ${preStopHeight}`)
    }
    for (let n = preStopHeight + 1; n <= haltHeight; n++) {
        const atHeight = rows.filter(r => r.number === n && survivors.includes(r.node))
        if (atHeight.length !== survivors.length) {
            reasons.push(
                `settle block ${n}: stored on ${atHeight.length}/${survivors.length} survivors`,
            )
            continue
        }
        if (new Set(atHeight.map(r => r.hash)).size !== 1) {
            reasons.push(
                `settle block ${n}: hash divergence ` +
                    atHeight.map(r => `node-${r.node}=${r.hash}`).join(", "),
            )
        }
        for (const r of atHeight) {
            if (r.signatures < quorum) {
                reasons.push(
                    `settle block ${n} on node-${r.node}: ${r.signatures} signatures < quorum ${quorum} ` +
                        "(committed after the stop without quorum)",
                )
            }
        }
    }
    return { pass: reasons.length === 0, reasons }
}

/**
 * Recovery criteria: every node reached `targetHeight`, all nodes store
 * the same hash at each height from `preStopHeight` to `targetHeight`,
 * and every block above `preStopHeight` carries at least `quorum`
 * signatures. Checking from the pre-stop height, not the halt height,
 * covers blocks committed during the settle period as well.
 */
export function evaluateRecovery(
    nodes: number[],
    preStopHeight: number,
    targetHeight: number,
    heads: Record<number, number>,
    rows: BlockRow[],
    quorum: number,
): Verdict {
    const reasons: string[] = []
    for (const id of nodes) {
        const h = heads[id]
        if (h === undefined || h < targetHeight) {
            reasons.push(`node-${id} head ${h ?? "none"} < target ${targetHeight}`)
        }
    }
    for (let n = preStopHeight; n <= targetHeight; n++) {
        const atHeight = rows.filter(r => r.number === n)
        const hashes = new Set(atHeight.map(r => r.hash))
        if (atHeight.length !== nodes.length) {
            reasons.push(`height ${n}: stored on ${atHeight.length}/${nodes.length} nodes`)
        } else if (hashes.size !== 1) {
            reasons.push(
                `height ${n}: hash divergence ` +
                    atHeight.map(r => `node-${r.node}=${r.hash}`).join(", "),
            )
        }
        if (n > preStopHeight) {
            for (const r of atHeight) {
                if (r.signatures < quorum) {
                    reasons.push(
                        `height ${n} on node-${r.node}: ${r.signatures} signatures < quorum ${quorum}`,
                    )
                }
            }
        }
    }
    return { pass: reasons.length === 0, reasons }
}

/**
 * Wall-clock marks (`Date.now()` values) taken by the drill, null until the
 * drill reaches that point.
 */
export interface DrillMarks {
    t_up: number | null
    t_baseline: number | null
    t_stop: number | null
    t_halt_confirmed: number | null
    t_hold_end: number | null
    t_restart: number | null
    t_first_new_block: number | null
    t_converged: number | null
}

/** Phase durations in ms; null when a mark either side of the phase is missing. */
export interface PhaseDurations {
    coldStartToBaselineMs: number | null
    stopToHaltConfirmedMs: number | null
    haltHoldMs: number | null
    restartToFirstNewBlockMs: number | null
    restartToConvergedMs: number | null
    /** `t_converged - t_up`. */
    totalMs: number | null
}

export function emptyMarks(): DrillMarks {
    return {
        t_up: null,
        t_baseline: null,
        t_stop: null,
        t_halt_confirmed: null,
        t_hold_end: null,
        t_restart: null,
        t_first_new_block: null,
        t_converged: null,
    }
}

function between(from: number | null, to: number | null): number | null {
    if (from === null || to === null) return null
    return Number.isFinite(from) && Number.isFinite(to) ? to - from : null
}

/**
 * Differences between marks. A missing mark gives null for the phases that
 * use it. Marks are not reordered or clamped: a mark out of order shows up
 * as a negative duration.
 */
export function phaseDurations(marks: DrillMarks): PhaseDurations {
    return {
        coldStartToBaselineMs: between(marks.t_up, marks.t_baseline),
        stopToHaltConfirmedMs: between(marks.t_stop, marks.t_halt_confirmed),
        haltHoldMs: between(marks.t_halt_confirmed, marks.t_hold_end),
        restartToFirstNewBlockMs: between(marks.t_restart, marks.t_first_new_block),
        restartToConvergedMs: between(marks.t_restart, marks.t_converged),
        totalMs: between(marks.t_up, marks.t_converged),
    }
}

/** Milliseconds as seconds with one decimal, "n/a" when missing. */
export function formatSeconds(ms: number | null): string {
    return ms === null || !Number.isFinite(ms) ? "n/a" : `${(ms / 1000).toFixed(1)}s`
}

/** Restart counts must not change while a container is meant to stay up. */
export function evaluateNoCrash(
    before: Record<number, number>,
    after: Record<number, number>,
    nodes: number[],
): Verdict {
    const reasons: string[] = []
    for (const id of nodes) {
        if (before[id] !== after[id]) {
            reasons.push(
                `node-${id} restart count ${before[id]} -> ${after[id]}: it exited during the drill`,
            )
        }
    }
    return { pass: reasons.length === 0, reasons }
}
