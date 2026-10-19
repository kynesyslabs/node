import { getSharedState } from "@/utilities/sharedState"

export const EXPIRED_TX_DEEP_WINDOW_MULTIPLIER = 5

export function isReferenceBlockAllowed(
    referenceBlock: number,
    lastBlock: number,
) {
    return (
        referenceBlock >= lastBlock - getSharedState.referenceBlockRoom &&
        referenceBlock <= lastBlock
    )
}

export function deepWindowCutoff(lastBlock: number): number {
    return (
        lastBlock -
        EXPIRED_TX_DEEP_WINDOW_MULTIPLIER * getSharedState.referenceBlockRoom
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
