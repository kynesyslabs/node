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
