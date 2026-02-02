import { Peer } from "@/libs/peer"
import { getSharedState } from "@/utilities/sharedState"
import log from "@/utilities/logger"
// FIX: Default import for the service class and use relative path or alias correctly
import L2PSMempool from "@/libs/blockchain/l2ps_mempool"
import type { L2PSTransaction } from "@kynesyslabs/demosdk/types"

/**
 * L2PS Concurrent Sync Utilities
 * 
 * Provides functions to synchronize L2PS mempools between participants
 * concurrent with the main blockchain sync.
 */

// Cache of L2PS participants: l2psUid -> Set of nodeIds
const l2psParticipantCache = new Map<string, Set<string>>()

/**
 * Discover L2PS participants among connected peers.
 * Queries peers for their "getL2PSParticipationById" status.
 * 
 * @param peers List of peers to query
 */
export async function discoverL2PSParticipants(peers: Peer[]): Promise<void> {
    const myUids = getSharedState.l2psJoinedUids || []
    if (myUids.length === 0) return

    for (const uid of myUids) {
        for (const peer of peers) {
            try {
                // If we already know this peer participates, skip query
                const cached = l2psParticipantCache.get(uid)
                if (cached?.has(peer.identity)) continue

                // Query peer
                peer.call({
                    method: "nodeCall",
                    params: [{
                        message: "getL2PSParticipationById",
                        data: { l2psUid: uid },
                        muid: `l2ps_discovery_${Date.now()}` // Unique ID
                    }]
                }).then(response => {
                    if (response?.result === 200 && response?.response?.participating) {
                        addL2PSParticipant(uid, peer.identity)
                        log.debug(`[L2PS-SYNC] Discovered participant for ${uid}: ${peer.identity}`)

                        // Opportunistic sync after discovery
                        syncL2PSWithPeer(peer, uid)
                    }
                }).catch(() => {
                    // Ignore errors during discovery
                })

            } catch {
                // Discovery errors are non-critical, peer may be unreachable
            }
        }
    }
}

/**
 * Register a peer as an L2PS participant in the local cache
 */
export function addL2PSParticipant(l2psUid: string, nodeId: string): void {
    if (!l2psParticipantCache.has(l2psUid)) {
        l2psParticipantCache.set(l2psUid, new Set())
    }
    l2psParticipantCache.get(l2psUid)?.add(nodeId)
}

/**
 * Clear the participant cache (e.g. on network restart)
 */
export function clearL2PSCache(): void {
    l2psParticipantCache.clear()
}

/**
 * Synchronize L2PS mempool with a specific peer for a specific network.
 * Uses delta sync based on last received timestamp.
 */
export async function syncL2PSWithPeer(peer: Peer, l2psUid: string): Promise<void> {
    try {
        // 1. Get local high-water mark (latest timestamp)
        const latestTx = await L2PSMempool.getLastTransaction(l2psUid)
        const sinceTimestamp = latestTx ? Number(latestTx.timestamp) : 0

        // 2. Request transactions from peer
        const response = await peer.call({
            method: "nodeCall",
            params: [{
                message: "getL2PSTransactions",
                data: {
                    l2psUid: l2psUid,
                    since_timestamp: sinceTimestamp
                },
                muid: `l2ps_sync_${Date.now()}`
            }]
        })

        if (response?.result === 200 && response.response?.transactions) {
            const txs = response.response.transactions as any[] // Using any to avoid strict type mismatch with raw response
            if (txs.length === 0) return

            log.info(`[L2PS-SYNC] Received ${txs.length} transactions from ${peer.identity} for ${l2psUid}`)

            // 3. Process transactions (verify & store)
            for (const txData of txs) {
                try {
                    // Extract and validate L2PS transaction object
                    const l2psTx = txData.encrypted_tx
                    const originalHash = txData.original_hash

                    if (!l2psTx || !originalHash || !l2psTx.hash || !l2psTx.content) {
                        log.debug(`[L2PS-SYNC] Invalid transaction structure received from ${peer.identity}`)
                        continue
                    }

                    // Cast to typed object after structural check
                    const validL2PSTx = l2psTx as L2PSTransaction

                    // Add to mempool (handles duplication checks and internal storage)
                    const result = await L2PSMempool.addTransaction(l2psUid, validL2PSTx, originalHash, "processed")

                    if (!result.success && result.error !== "Transaction already processed" && result.error !== "Encrypted transaction already in L2PS mempool") {
                        log.debug(`[L2PS-SYNC] Failed to insert synced tx ${validL2PSTx.hash}: ${result.error}`)
                    }
                } catch (err) {
                    log.warning(`[L2PS-SYNC] Exception processing synced tx: ${err instanceof Error ? err.message : String(err)}`)
                }
            }
        }

    } catch (e) {
        log.warning(`[L2PS-SYNC] Failed to sync with ${peer.identity}: ${e instanceof Error ? e.message : String(e)}`)
    }
}

/**
 * Exchange participation info with new peers (Gossip style)
 */
export async function exchangeL2PSParticipation(peers: Peer[]): Promise<void> {
    // Piggyback on discovery for now
    await discoverL2PSParticipants(peers)
}
