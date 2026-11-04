import { getSharedState } from "src/utilities/sharedState"

import type Peer from "./Peer"
import type { SyncData } from "./Peer"

/**
 * What a peer's sync state reads as until it has told us something we can
 * check. A fresh object each time: callers store it as `peer.sync`, and
 * peer updates later write into that object in place, so a shared one would
 * make every peer with an unknown height read as whatever was written last.
 */
export function unknownSync(): SyncData {
    return { status: false, block: null, block_hash: null }
}

/**
 * A peer's self-reported sync state, kept only when our own chain backs it:
 * a height we have, carrying the hash we have for it. Anything else reads as
 * unknown.
 *
 * A well-formed claim we cannot back is still not dropped when `from` is the
 * peer that made it: a height above ours is the only sign a node that missed
 * a push gets that it is behind, so it is handed to the height probe, which
 * fetches and verifies the blocks before anything is adopted or credited.
 */
export async function corroborateSyncData(
    claim: unknown,
    from?: Peer,
): Promise<SyncData> {
    if (claim === null || typeof claim !== "object") return unknownSync()
    const { status, block, block_hash: blockHash } = claim as Record<string, unknown>
    if (!Number.isInteger(block) || (block as number) < 0) return unknownSync()
    if (typeof blockHash !== "string" || blockHash.length === 0) return unknownSync()
    if ((block as number) > (getSharedState.lastBlockNumber ?? 0)) {
        await probeClaim(from, block as number, blockHash)
        return unknownSync()
    }
    // Loaded here, not at module level: PeerManager imports this file and
    // the chain module imports PeerManager through the sync routines.
    const { default: chain } = await import("src/libs/blockchain/chain")
    const ours = await chain.getBlockByNumber(block as number)
    if (!ours || ours.hash !== blockHash) {
        await probeClaim(from, block as number, blockHash)
        return unknownSync()
    }
    return { status: status === true, block: block as number, block_hash: blockHash }
}

async function probeClaim(
    from: Peer | undefined,
    height: number,
    hash: string,
): Promise<void> {
    if (!from) return
    try {
        // Loaded lazily for the same cycle: the probe reaches PeerManager
        const { scheduleHeightProbe } = await import(
            "src/libs/consensus/v2/routines/committedBlock"
        )
        scheduleHeightProbe(from, height, hash)
    } catch {
        // A failed probe must not fail the hello that carried the claim
    }
}
