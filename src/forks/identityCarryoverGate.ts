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
 * Whether a genesis document schedules `identityCarryover` at 0. Checks on an
 * existing chain read block 0's stored copy, which no later edit of
 * data/genesis.json can change.
 */
export function identityCarryoverScheduledAtZero(genesisData: unknown): boolean {
    if (genesisData === null || typeof genesisData !== "object") return false
    const forks = (genesisData as { forks?: unknown }).forks
    if (forks === null || typeof forks !== "object") return false
    const fork = (forks as Record<string, unknown>).identityCarryover
    if (fork === null || typeof fork !== "object") return false
    return (fork as { activationHeight?: unknown }).activationHeight === 0
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
