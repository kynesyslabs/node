import { isForkActive } from "@/forks/forkGates"
import { getSharedState } from "@/utilities/sharedState"

export const EXPIRED_TX_DEEP_WINDOW_MULTIPLIER = 5

/** How far behind the head a reference block may be before `referenceBlockRoom10`. */
export const LEGACY_REFERENCE_BLOCK_ROOM = 1

/** How far behind the head a reference block may be from `referenceBlockRoom10` on. */
export const REFERENCE_BLOCK_ROOM = 10

/**
 * The room of the block forged on `head`. Every user judges a block on the
 * rule of its own tip, so an old block verifies with the room it was
 * forged under and every validator agrees on the same block.
 */
export function referenceBlockRoomAt(head: number): number {
    return isForkActive("referenceBlockRoom10", head)
        ? REFERENCE_BLOCK_ROOM
        : LEGACY_REFERENCE_BLOCK_ROOM
}

export function isReferenceBlockAllowed(
    referenceBlock: number,
    lastBlock: number,
) {
    return (
        referenceBlock >= lastBlock - referenceBlockRoomAt(lastBlock) &&
        referenceBlock <= lastBlock
    )
}

export function deepWindowCutoff(lastBlock: number): number {
    return (
        lastBlock -
        EXPIRED_TX_DEEP_WINDOW_MULTIPLIER * referenceBlockRoomAt(lastBlock)
    )
}

/**
 * A tx may be admitted to the mempool while its reference block is inside
 * the deep window: not older than the cutoff and not ahead of our head.
 * Expired-but-recent txs are admitted so consensus can include them as
 * failed; anything older is dropped before validation.
 */
export function isWithinDeepWindow(
    referenceBlock: number,
    head: number,
): boolean {
    return referenceBlock >= deepWindowCutoff(head) && referenceBlock <= head
}

const SIGNATURE_RULE_FORKS = ["osDenomination", "signatureDomain"] as const

/**
 * Heights whose rules a block's transactions may legitimately have been
 * admitted under, besides the block's own: the height before each fork that
 * activated no more than a deep window ago.
 *
 * The forger admits a tx under the rules of the tip it saw and never
 * revalidates its mempool. A tx kept for a later round (a nonce ahead of its
 * predecessor) can therefore reach a block after a fork activated, for as long
 * as its reference block is still inside the deep window; past that the forger
 * drops it. Every fork rule is judged separately because they activate at
 * different heights. The deep window is the one of the block's own tip.
 */
export function previousRuleHeights(height: number): number[] {
    const window =
        EXPIRED_TX_DEEP_WINDOW_MULTIPLIER * referenceBlockRoomAt(height - 1)
    const heights = new Set<number>()
    for (const fork of SIGNATURE_RULE_FORKS) {
        const activation = getSharedState.forkConfig?.[fork]?.activationHeight
        if (
            activation !== null &&
            activation !== undefined &&
            activation > 0 &&
            height >= activation &&
            height < activation + window
        ) {
            heights.add(activation - 1)
        }
    }
    return [...heights]
}
