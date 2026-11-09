import { getSharedState } from "@/utilities/sharedState"
import { isForkActive } from "./forkGates"

/**
 * Whether an xm identity remove matches stored entries by the chain's
 * canonical address form. Apply-time rules may only change at a fork height,
 * or a node replaying old blocks would store different state; judged at the
 * tip like the other apply-time gates.
 */
export function xmRemoveCanonicalActiveAtApply(): boolean {
    return isForkActive("xmRemoveCanonical", getSharedState.lastBlockNumber ?? 0)
}
