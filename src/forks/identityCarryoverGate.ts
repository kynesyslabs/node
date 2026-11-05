import { getSharedState } from "@/utilities/sharedState"
import { isForkActive } from "./forkGates"

/**
 * Whether block 0 is built under `identityCarryover`: the snapshot import
 * then refuses balances and records the identities it carries over.
 */
export function identityCarryoverActiveAtGenesis(): boolean {
    return isForkActive("identityCarryover", 0)
}

/**
 * Whether block application pays no first-link award for an imported
 * identity and unlinks web2 accounts by userId. Apply-time rules may only
 * change at a fork height, or a node replaying old blocks would store
 * different state; judged at the tip like the other apply-time gates.
 */
export function identityCarryoverActiveAtApply(): boolean {
    return isForkActive(
        "identityCarryover",
        getSharedState.lastBlockNumber ?? 0,
    )
}
