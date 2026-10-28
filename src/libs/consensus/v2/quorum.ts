/**
 * The block quorum, in one place for the three sides that apply it: the
 * committee floor below which no shard forms, the producer deciding whether
 * its vote tally commits a block, and sync deciding whether a received
 * block carries enough signatures. They must agree, or a syncing node can
 * accept a block that no honest producer would have committed.
 */

/** 2/3 + 1 of a full committee: the pro votes a block needs. */
export function quorumThreshold(shardSize: number): number {
    return Math.floor((shardSize * 2) / 3) + 1
}

/**
 * Whether a producer commits its block. The tally must clear 2/3 + 1 of
 * the members it polled and, independently, 2/3 + 1 of a full committee,
 * so a shard that shrank after liveness filtering cannot lower the bar.
 */
export function producerCommits(
    pro: number,
    committeeSize: number,
    shardSize: number,
): boolean {
    return (
        pro >= quorumThreshold(shardSize) && pro >= quorumThreshold(committeeSize)
    )
}

/**
 * Signatures sync requires on a block. With `parity` the bar is the
 * producer's: 2/3 + 1 of a full committee. Without it, the pre-fork rule
 * counts against min(shardSize, pool), which a small committed peerlist
 * lowers below anything a producer commits.
 */
export function verifierThreshold(
    shardSize: number,
    poolSize: number,
    parity: boolean,
): number {
    if (parity) return quorumThreshold(shardSize)
    return quorumThreshold(Math.min(shardSize, poolSize))
}
