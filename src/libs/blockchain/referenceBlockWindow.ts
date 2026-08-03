import { getSharedState } from "@/utilities/sharedState"

export const EXPIRED_TX_DEEP_WINDOW_MULTIPLIER = 5

export function deepWindowCutoff(lastBlock: number): number {
    return (
        lastBlock -
        EXPIRED_TX_DEEP_WINDOW_MULTIPLIER * getSharedState.referenceBlockRoom
    )
}
