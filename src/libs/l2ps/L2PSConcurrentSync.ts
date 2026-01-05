import { randomUUID } from "crypto"
import { Peer } from "@/libs/peer/Peer"
import L2PSMempool from "@/libs/blockchain/l2ps_mempool"
import log from "@/utilities/logger"
import type { RPCResponse } from "@kynesyslabs/demosdk/types"

/**
 * Discover which peers participate in specific L2PS UIDs
 *
 * Uses parallel queries to efficiently discover L2PS participants across
 * the network. Queries all peers for each L2PS UID and builds a map of
 * participants.
 *
 * @param peers - List of peers to query for L2PS participation
 * @param l2psUids - L2PS network UIDs to check participation for
 * @returns Map of L2PS UID to participating peers
 *
 * @example
 * ```typescript
 * const peers = PeerManager.getConnectedPeers()
 * const l2psUids = ["network_1", "network_2"]
 * const participantMap = await discoverL2PSParticipants(peers, l2psUids)
 *
 * console.log(`Network 1 has ${participantMap.get("network_1")?.length} participants`)
 * ```
 */
export async function discoverL2PSParticipants(
    peers: Peer[],
    l2psUids: string[],
): Promise<Map<string, Peer[]>> {
    const participantMap = new Map<string, Peer[]>()

    // Initialize map with empty arrays for each UID
    for (const uid of l2psUids) {
        participantMap.set(uid, [])
    }

    // Query all peers in parallel for all UIDs
    const discoveryPromises: Promise<void>[] = []

    for (const peer of peers) {
        for (const l2psUid of l2psUids) {
            const promise = (async () => {
                try {
                    // Query peer for L2PS participation
                    const response: RPCResponse = await peer.call({
                        message: "getL2PSParticipationById",
                        data: { l2psUid },
                        muid: `discovery_${l2psUid}_${randomUUID()}`,
                    })

                    // If peer participates, add to map
                    if (response.result === 200 && response.response?.participating === true) {
                        const participants = participantMap.get(l2psUid)
                        if (participants) {
                            participants.push(peer)
                            log.debug(`[L2PS Sync] Peer ${peer.muid} participates in L2PS ${l2psUid}`)
                        }
                    }
                } catch (error) {
                    // Gracefully handle peer failures (don't break discovery)
                    const message = error instanceof Error ? error.message : String(error)
                    log.debug(`[L2PS Sync] Failed to query peer ${peer.muid} for ${l2psUid}:`, message)
                }
            })()

            discoveryPromises.push(promise)
        }
    }

    // Wait for all discovery queries to complete
    await Promise.allSettled(discoveryPromises)

    // Log discovery statistics
    let totalParticipants = 0
    for (const [uid, participants] of participantMap.entries()) {
        totalParticipants += participants.length
        log.info(`[L2PS Sync] Discovered ${participants.length} participants for L2PS ${uid}`)
    }
    log.info(`[L2PS Sync] Discovery complete: ${totalParticipants} total participants across ${l2psUids.length} networks`)

    return participantMap
}

/**
 * Sync L2PS mempool with a specific peer
 *
 * Performs incremental sync by:
 * 1. Getting peer's mempool info (transaction count, timestamps)
 * 2. Comparing with local mempool
 * 3. Requesting missing transactions from peer
 * 4. Validating and inserting into local mempool
 *
 * @param peer - Peer to sync L2PS mempool with
 * @param l2psUid - L2PS network UID to sync
 * @returns Promise that resolves when sync is complete
 *
 * @example
 * ```typescript
 * const peer = PeerManager.getPeerByMuid("peer_123")
 * await syncL2PSWithPeer(peer, "network_1")
 * console.log("Sync complete!")
 * ```
 */
export async function syncL2PSWithPeer(
    peer: Peer,
    l2psUid: string,
): Promise<void> {
    try {
        log.debug(`[L2PS Sync] Starting sync with peer ${peer.muid} for L2PS ${l2psUid}`)

        // Step 1: Get peer's mempool info
        const infoResponse: RPCResponse = await peer.call({
            message: "getL2PSMempoolInfo",
            data: { l2psUid },
            muid: `sync_info_${l2psUid}_${randomUUID()}`,
        })

        if (infoResponse.result !== 200 || !infoResponse.response) {
            log.warning(`[L2PS Sync] Peer ${peer.muid} returned invalid mempool info for ${l2psUid}`)
            return
        }

        const peerInfo = infoResponse.response
        const peerTxCount = peerInfo.transactionCount || 0

        if (peerTxCount === 0) {
            log.debug(`[L2PS Sync] Peer ${peer.muid} has no transactions for ${l2psUid}`)
            return
        }

        // Step 2: Get local mempool info
        const localTxs = await L2PSMempool.getByUID(l2psUid, "processed")
        const localTxCount = localTxs.length
        const localLastTimestamp = localTxs.length > 0
            ? localTxs[localTxs.length - 1].timestamp
            : 0

        log.debug(`[L2PS Sync] Local: ${localTxCount} txs, Peer: ${peerTxCount} txs for ${l2psUid}`)

        // Step 3: Request transactions newer than our latest (incremental sync)
        const txResponse: RPCResponse = await peer.call({
            message: "getL2PSTransactions",
            data: {
                l2psUid,
                since_timestamp: localLastTimestamp, // Only get newer transactions
            },
            muid: `sync_txs_${l2psUid}_${randomUUID()}`,
        })

        if (txResponse.result !== 200 || !txResponse.response?.transactions) {
            log.warning(`[L2PS Sync] Peer ${peer.muid} returned invalid transactions for ${l2psUid}`)
            return
        }

        const transactions = txResponse.response.transactions
        log.debug(`[L2PS Sync] Received ${transactions.length} transactions from peer ${peer.muid}`)

        // Step 5: Insert transactions into local mempool
        let insertedCount = 0
        let duplicateCount = 0

        if (transactions.length === 0) {
            log.debug("[L2PS Sync] No transactions to process")
            return
        }

        // Batch duplicate detection: check all hashes at once
        const txHashes = transactions.map(tx => tx.hash)
        const existingHashes = new Set<string>()

        // Query database once for all hashes
        try {
            if (!L2PSMempool.repo) {
                throw new Error("[L2PS Sync] L2PSMempool repository not initialized")
            }

            const existingTxs = await L2PSMempool.repo.createQueryBuilder("tx")
                .where("tx.hash IN (:...hashes)", { hashes: txHashes })
                .select("tx.hash")
                .getMany()

            for (const tx of existingTxs) {
                existingHashes.add(tx.hash)
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            log.error("[L2PS Sync] Failed to batch check duplicates:", message)
            throw error
        }

        // Filter out duplicates and insert new transactions
        for (const tx of transactions) {
            try {
                // Check against pre-fetched duplicates
                if (existingHashes.has(tx.hash)) {
                    duplicateCount++
                    continue
                }

                // Insert transaction into local mempool
                const result = await L2PSMempool.addTransaction(
                    tx.l2ps_uid,
                    tx.encrypted_tx,
                    tx.original_hash,
                    "processed",
                )

                if (result.success) {
                    insertedCount++
                } else {
                    // addTransaction failed (validation or duplicate)
                    if (result.error?.includes("already")) {
                        duplicateCount++
                    } else {
                        log.error(`[L2PS Sync] Failed to add transaction ${tx.hash}: ${result.error}`)
                    }
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                log.error(`[L2PS Sync] Failed to insert transaction ${tx.hash}:`, message)
            }
        }

        log.info(`[L2PS Sync] Sync complete for ${l2psUid}: ${insertedCount} new, ${duplicateCount} duplicates`)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.error(`[L2PS Sync] Failed to sync with peer ${peer.muid} for ${l2psUid}:`, message)
        throw error
    }
}

/**
 * Exchange L2PS participation info with peers
 *
 * Broadcasts local L2PS participation to all peers. This is a fire-and-forget
 * operation that informs peers which L2PS networks this node participates in.
 * Peers can use this information to route L2PS transactions and sync requests.
 *
 * @param peers - List of peers to broadcast participation info to
 * @param l2psUids - L2PS network UIDs that this node participates in
 * @returns Promise that resolves when broadcast is complete
 *
 * @example
 * ```typescript
 * const peers = PeerManager.getConnectedPeers()
 * const myL2PSNetworks = ["network_1", "network_2"]
 * await exchangeL2PSParticipation(peers, myL2PSNetworks)
 * console.log("Participation info broadcasted")
 * ```
 */
export async function exchangeL2PSParticipation(
    peers: Peer[],
    l2psUids: string[],
): Promise<void> {
    if (l2psUids.length === 0) {
        log.debug("[L2PS Sync] No L2PS UIDs to exchange")
        return
    }

    log.debug(`[L2PS Sync] Broadcasting participation in ${l2psUids.length} L2PS networks to ${peers.length} peers`)

    // Broadcast to all peers in parallel (fire and forget)
    const exchangePromises = peers.map(async (peer) => {
        try {
            // Send participation info for each L2PS UID
            for (const l2psUid of l2psUids) {
                await peer.call({
                    message: "announceL2PSParticipation",
                    data: { l2psUid },
                    muid: `exchange_${l2psUid}_${randomUUID()}`,
                })
            }
            log.debug(`[L2PS Sync] Exchanged participation info with peer ${peer.muid}`)
        } catch (error) {
            // Gracefully handle failures (don't break exchange process)
            const message = error instanceof Error ? error.message : String(error)
            log.debug(`[L2PS Sync] Failed to exchange with peer ${peer.muid}:`, message)
        }
    })

    // Wait for all exchanges to complete (or fail)
    await Promise.allSettled(exchangePromises)

    log.info(`[L2PS Sync] Participation exchange complete for ${l2psUids.length} networks`)
}
