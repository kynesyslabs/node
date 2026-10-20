import { getSharedState } from "src/utilities/sharedState"

import type { SyncData } from "./Peer"

/** What a peer's sync state reads as until it has told us something we can check. */
export const UNKNOWN_SYNC: SyncData = { status: false, block: null, block_hash: null }

/**
 * A peer's self-reported sync state, kept only when our own chain backs it:
 * a height we have, carrying the hash we have for it. Anything else reads as
 * unknown. Heights ahead of ours reach us as signed gossip heights records
 * instead, where the staked set and the rate budget apply.
 */
export async function corroborateSyncData(claim: unknown): Promise<SyncData> {
    if (claim === null || typeof claim !== "object") return UNKNOWN_SYNC
    const { status, block, block_hash: blockHash } = claim as Record<string, unknown>
    if (!Number.isInteger(block) || (block as number) < 0) return UNKNOWN_SYNC
    if (typeof blockHash !== "string" || blockHash.length === 0) return UNKNOWN_SYNC
    if ((block as number) > (getSharedState.lastBlockNumber ?? 0)) return UNKNOWN_SYNC
    // Loaded here, not at module level: PeerManager imports this file and
    // the chain module imports PeerManager through the sync routines.
    const { default: chain } = await import("src/libs/blockchain/chain")
    const ours = await chain.getBlockByNumber(block as number)
    if (!ours || ours.hash !== blockHash) return UNKNOWN_SYNC
    return { status: status === true, block: block as number, block_hash: blockHash }
}
