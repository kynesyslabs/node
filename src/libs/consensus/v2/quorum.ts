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
 * Observations an identity needs to enter the merged peerlist under
 * `peerlistFloor`: one more than the members a block can do without. A
 * coalition below `quorum` leaves at least that many honest members, so
 * every honest member's report together reaches the floor and a list
 * without them gets no honest signature. `quorum` is the block's signature
 * bar, which a committee short of shardSize must still reach, so the floor
 * follows the committee's real size, never shardSize.
 */
export function peerlistFloorThreshold(voters: number, quorum: number): number {
    return Math.max(1, voters - quorum + 1)
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
