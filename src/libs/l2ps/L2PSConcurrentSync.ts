import { randomUUID } from "crypto"
import { Peer } from "@/libs/peer/Peer"
import L2PSMempool from "@/libs/blockchain/l2ps_mempool"
import log from "@/utilities/logger"
import type { RPCResponse } from "@kynesyslabs/demosdk/types"
import { getErrorMessage } from "@/utilities/errorMessage"

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
                    log.debug(`[L2PS Sync] Failed to query peer ${peer.muid} for ${l2psUid}: ${getErrorMessage(error)}`)
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

async function getPeerMempoolInfo(peer: Peer, l2psUid: string): Promise<number> {
    const infoResponse: RPCResponse = await peer.call({
        message: "getL2PSMempoolInfo",
        data: { l2psUid },
        muid: `sync_info_${l2psUid}_${randomUUID()}`,
    })

    if (infoResponse.result !== 200 || !infoResponse.response) {
        log.warning(`[L2PS Sync] Peer ${peer.muid} returned invalid mempool info for ${l2psUid}`)
        return 0
    }

    return infoResponse.response.transactionCount || 0
}

async function getLocalMempoolInfo(l2psUid: string): Promise<{ count: number, lastTimestamp: any }> {
    const localTxs = await L2PSMempool.getByUID(l2psUid, "processed")
    const lastTx = localTxs.at(-1)
    return {
        count: localTxs.length,
        lastTimestamp: lastTx ? lastTx.timestamp : 0
    }
}

async function fetchPeerTransactions(peer: Peer, l2psUid: string, sinceTimestamp: any): Promise<any[]> {
    const txResponse: RPCResponse = await peer.call({
        message: "getL2PSTransactions",
        data: {
            l2psUid,
            since_timestamp: sinceTimestamp,
        },
        muid: `sync_txs_${l2psUid}_${randomUUID()}`,
    })

    if (txResponse.result !== 200 || !txResponse.response?.transactions) {
        log.warning(`[L2PS Sync] Peer ${peer.muid} returned invalid transactions for ${l2psUid}`)
        return []
    }

    return txResponse.response.transactions
}

async function processSyncTransactions(transactions: any[], l2psUid: string): Promise<{ inserted: number, duplicates: number }> {
    if (transactions.length === 0) return { inserted: 0, duplicates: 0 }

    let insertedCount = 0
    let duplicateCount = 0

    const txHashes = transactions.map(tx => tx.hash)
    const existingHashes = new Set<string>()

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
        log.error(`[L2PS Sync] Failed to batch check duplicates: ${getErrorMessage(error)}`)
        throw error
    }

    for (const tx of transactions) {
        try {
            if (existingHashes.has(tx.hash)) {
                duplicateCount++
                continue
            }

            const result = await L2PSMempool.addTransaction(
                tx.l2ps_uid,
                tx.encrypted_tx,
                tx.original_hash,
                "processed",
            )

            if (result.success) {
                insertedCount++
            } else if (result.error?.includes("already")) {
                duplicateCount++
            } else {
                log.error(`[L2PS Sync] Failed to add transaction ${tx.hash}: ${result.error}`)
            }
        } catch (error) {
            log.error(`[L2PS Sync] Failed to insert transaction ${tx.hash}: ${getErrorMessage(error)}`)
        }
    }

    return { inserted: insertedCount, duplicates: duplicateCount }
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

        const peerTxCount = await getPeerMempoolInfo(peer, l2psUid)
        if (peerTxCount === 0) {
            log.debug(`[L2PS Sync] Peer ${peer.muid} has no transactions for ${l2psUid}`)
            return
        }

        const { count: localTxCount, lastTimestamp: localLastTimestamp } = await getLocalMempoolInfo(l2psUid)
        log.debug(`[L2PS Sync] Local: ${localTxCount} txs, Peer: ${peerTxCount} txs for ${l2psUid}`)

        const transactions = await fetchPeerTransactions(peer, l2psUid, localLastTimestamp)
        log.debug(`[L2PS Sync] Received ${transactions.length} transactions from peer ${peer.muid}`)

        if (transactions.length === 0) {
            log.debug("[L2PS Sync] No transactions to process")
            return
        }

        const { inserted, duplicates } = await processSyncTransactions(transactions, l2psUid)
        log.info(`[L2PS Sync] Sync complete for ${l2psUid}: ${inserted} new, ${duplicates} duplicates`)

    } catch (error) {
        log.error(`[L2PS Sync] Failed to sync with peer ${peer.muid} for ${l2psUid}: ${getErrorMessage(error)}`)
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
            log.debug(`[L2PS Sync] Failed to exchange with peer ${peer.muid}: ${getErrorMessage(error)}`)
        }
    })

    // Wait for all exchanges to complete (or fail)
    await Promise.allSettled(exchangePromises)

    log.info(`[L2PS Sync] Participation exchange complete for ${l2psUids.length} networks`)
}
