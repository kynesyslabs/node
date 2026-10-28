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
 * Halt criteria, evaluated over the samples taken after the settle
 * period: every survivor answers every sample, and no survivor's head
 * moves above `haltHeight` (the highest head seen once the settle period
 * ended).
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
 * Recovery criteria: every node reached `targetHeight`, all nodes store
 * the same hash at each checked height, and every block above the halt
 * height carries at least `quorum` signatures.
 */
export function evaluateRecovery(
    nodes: number[],
    haltHeight: number,
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
    for (let n = haltHeight; n <= targetHeight; n++) {
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
        if (n > haltHeight) {
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
