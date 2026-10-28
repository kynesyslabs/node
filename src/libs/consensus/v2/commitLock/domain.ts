import { isForkActive } from "@/forks/forkGates"
import log from "src/utilities/logger"

/**
 * What a committee member signs under `commitLock`. The height and the round
 * are inside the signed message, so a prevote cannot be replayed as a
 * precommit, and a signature from one height or round cannot count at
 * another. Before the fork a member signs the raw block hash.
 */

export const PREVOTE_DOMAIN = "demos-prevote"
export const PRECOMMIT_DOMAIN = "demos-precommit"

let misconfiguredReported = false

/**
 * Whether the commit lock rules apply to block `height`. The loader refuses
 * a genesis that schedules commitLock without committeeBinding; state set
 * any other way is treated as dormant, because the lock's quorums only
 * overlap inside one bound committee.
 */
export function commitLockActive(height: number): boolean {
    if (!isForkActive("commitLock", height)) return false
    if (isForkActive("committeeBinding", height)) return true
    if (!misconfiguredReported) {
        misconfiguredReported = true
        log.error(
            `[commitLock] commitLock is active at ${height} without committeeBinding; treating it as inactive`,
        )
    }
    return false
}

/** A round is the secretary timestamp of an attempt: a positive integer. */
export function isRound(value: unknown): value is number {
    return (
        typeof value === "number" && Number.isSafeInteger(value) && value > 0
    )
}

export function prevoteMessage(
    height: number,
    round: number,
    hash: string,
): string {
    return `${PREVOTE_DOMAIN}:${height}:${round}:${hash}`
}

export function precommitMessage(
    height: number,
    round: number,
    hash: string,
): string {
    return `${PRECOMMIT_DOMAIN}:${height}:${round}:${hash}`
}

interface RoundedBlock {
    number: number
    hash: string
    validation_data?: { round?: unknown } | null
}

/**
 * The message a candidate's vote signatures sign: the prevote under the
 * fork, the raw hash before it. Null when the fork applies and the
 * candidate carries no round, which no vote can then be checked against.
 */
export function voteMessageOf(block: RoundedBlock): string | null {
    if (!commitLockActive(block.number)) return block.hash
    const round = block.validation_data?.round
    if (!isRound(round)) return null
    return prevoteMessage(block.number, round, block.hash)
}

/**
 * The message a block's certificate signs: one round's precommits under the
 * fork, the raw hash before it. Null when the fork applies and the block
 * carries no valid round.
 */
export function certificateMessageOf(block: RoundedBlock): string | null {
    if (!commitLockActive(block.number)) return block.hash
    const round = block.validation_data?.round
    if (!isRound(round)) return null
    return precommitMessage(block.number, round, block.hash)
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export function __resetCommitLockDomain(): void {
    misconfiguredReported = false
}
