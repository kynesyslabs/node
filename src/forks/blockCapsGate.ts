import { getSharedState } from "@/utilities/sharedState"
import { isForkActive } from "./forkGates"

/** Whether block `height` is held to the `blockCaps` limits. */
export function blockCapsActive(height: number): boolean {
    return isForkActive("blockCaps", height)
}

/**
 * Whether the mempool merge runs under `blockCaps`: judged for the block the
 * merge prepares (tip + 1), the height its pool is forged into.
 */
export function blockCapsActiveForPendingBlock(): boolean {
    return blockCapsActive((getSharedState.lastBlockNumber ?? 0) + 1)
}
