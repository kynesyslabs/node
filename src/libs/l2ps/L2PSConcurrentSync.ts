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
 * @param l2psUids Optional list of L2PS UIDs to discover for (defaults to shared state)
 * @returns Map of l2psUid -> array of participant node IDs
 */
export async function discoverL2PSParticipants(peers: Peer[], l2psUids?: string[]): Promise<Map<string, string[]>> {
    const myUids = l2psUids || getSharedState.l2psJoinedUids || []
    const result = new Map<string, string[]>()

    if (myUids.length === 0) return result

    // Collect all discovery promises so we can await them
    const discoveryPromises: Promise<void>[] = []

    for (const uid of myUids) {
        result.set(uid, [])

        for (const peer of peers) {
            try {
                // If we already know this peer participates, add to result and skip query
                const cached = l2psParticipantCache.get(uid)
                if (cached?.has(peer.identity)) {
                    result.get(uid)!.push(peer.identity)
                    continue
                }

                // Query peer
                const promise = peer.call({
                    method: "nodeCall",
                    params: [{
                        message: "getL2PSParticipationById",
                        data: { l2psUid: uid },
                        muid: `l2ps_discovery_${Date.now()}`, // Unique ID
                    }],
                }).then(response => {
                    if (response?.result === 200 && response?.response?.participating) {
                        addL2PSParticipant(uid, peer.identity)
                        result.get(uid)!.push(peer.identity)
                        log.debug(`[L2PS-SYNC] Discovered participant for ${uid}: ${peer.identity}`)

                        // Opportunistic sync after discovery
                        syncL2PSWithPeer(peer, uid).catch((err) => {
                            // Non-critical: sync will be retried later
                            log.debug(`[L2PS-SYNC] Opportunistic sync failed for ${uid}: ${err instanceof Error ? err.message : String(err)}`)
                        })
                    }
                }).catch((err) => {
                    // Discovery errors are non-critical, peer may be unreachable
                    log.debug(`[L2PS-SYNC] Discovery failed for peer: ${err instanceof Error ? err.message : String(err)}`)
                })

                discoveryPromises.push(promise)

            } catch {
                // Discovery errors are non-critical, peer may be unreachable
            }
        }
    }

    // Wait for all discovery queries to complete
    await Promise.allSettled(discoveryPromises)

    return result
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
/**
 * Where this node has read up to in each peer's history, by peer and subnet.
 *
 * The value is a cursor the peer issued, in the peer's own clock, and is only
 * ever echoed back to that peer. Taking a high-water mark from local state
 * instead — as this did — compares two machines' clocks: after inserting a
 * page under local timestamps, the mark jumps past everything still missing,
 * and a peer more than one page behind can never finish catching up.
 *
 * In memory on purpose. A restart resyncs from the beginning, which costs a
 * few duplicate inserts that the mempool already rejects.
 */
const syncCursors = new Map<string, number>()

export function clearL2PSSyncCursors(): void {
    syncCursors.clear()
    continuations.clear()
}

/**
 * Pages one sync run may pull from a peer. The peer decides whether there is
 * more, so the bound is this node's: a backlog larger than this drains over
 * the next runs instead of in one unbounded burst.
 */
export const MAX_SYNC_PAGES_PER_RUN = 20

/**
 * Pause before the next run when a run stopped at the page cap with the peer
 * still reporting more. Nothing else would start that run: block sync does
 * not, and discovery skips peers it already knows.
 */
let continueDelayMs = 1_000
export function setL2PSSyncContinueDelay(ms: number): void {
    continueDelayMs = ms
}

/**
 * Rows asked of a peer per page. Sent so the page size is this node's choice,
 * and enforced on the answer, since the peer is free to ignore it.
 */
export const SYNC_PAGE_LIMIT = 100

/**
 * Consecutive self-scheduled runs allowed for one peer and subnet before the
 * node stops scheduling its own and waits for the regular triggers (block sync,
 * discovery). A peer that answers "more" for ever with a rising cursor would
 * otherwise keep this node pulling and storing its pages without end.
 */
export const MAX_SYNC_CONTINUATIONS = 5

/** Runs in progress, by peer and subnet, so a scheduled one never overlaps another. */
const running = new Set<string>()

/** Self-scheduled runs since the peer last reported it had nothing more. */
const continuations = new Map<string, number>()

export async function syncL2PSWithPeer(peer: Peer, l2psUid: string): Promise<void> {
    const cursorKey = `${peer.identity}\u0000${l2psUid}`
    if (running.has(cursorKey)) return
    running.add(cursorKey)
    let more = false
    try {
        for (let page = 0; page < MAX_SYNC_PAGES_PER_RUN; page++) {
            more = false
            const cursor = syncCursors.get(cursorKey) ?? 0

            const response = await peer.call({
                method: "nodeCall",
                params: [{
                    message: "getL2PSTransactions",
                    data: {
                        l2psUid: l2psUid,
                        cursor,
                        limit: SYNC_PAGE_LIMIT,
                    },
                    muid: `l2ps_sync_${Date.now()}`,
                }],
            })

            if (response?.result !== 200 || !response.response?.transactions) return

            const body = response.response as {
                transactions: any[]
                nextCursor?: number
                hasMore?: boolean
            }
            const txs = Array.isArray(body.transactions)
                ? body.transactions.slice(0, SYNC_PAGE_LIMIT)
                : []

            // Advance even on an empty page: the peer may have skipped rows it
            // can no longer serve, and refusing to move would ask for them for
            // ever.
            const advanced = typeof body.nextCursor === "number" && body.nextCursor > cursor
            if (advanced) {
                syncCursors.set(cursorKey, body.nextCursor as number)
            }

            if (txs.length > 0) {
                log.info(`[L2PS-SYNC] Received ${txs.length} transactions from ${peer.identity} for ${l2psUid}`)
                await processReceivedTransactions(l2psUid, txs, peer.identity)
            }

            // Keep pulling while the peer says there is more, so a backlog
            // drains instead of being re-read one page at a time — but only
            // while its cursor moves. "More" with a cursor that stands still
            // is the same page again.
            if (!body.hasMore || !advanced) return
            more = true
        }
    } catch (e) {
        more = false
        log.warning(`[L2PS-SYNC] Failed to sync with ${peer.identity}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
        running.delete(cursorKey)
    }

    if (!more) {
        continuations.delete(cursorKey)
        return
    }

    // Stopped at the cap with more to come: carry on shortly, from the
    // stored cursor, rather than leave the rest missing until the next
    // trigger — but only a bounded number of times in a row.
    const scheduled = continuations.get(cursorKey) ?? 0
    if (scheduled >= MAX_SYNC_CONTINUATIONS) {
        log.info(`[L2PS-SYNC] ${peer.identity} still reports more for ${l2psUid} after ${scheduled} continuations; resuming on the next sync trigger`)
        return
    }
    continuations.set(cursorKey, scheduled + 1)
    setTimeout(() => {
        syncL2PSWithPeer(peer, l2psUid).catch(() => undefined)
    }, continueDelayMs)
}

/**
 * Exchange participation info with new peers (Gossip style)
 */
export async function exchangeL2PSParticipation(peers: Peer[]): Promise<void> {
    // Piggyback on discovery for now
    await discoverL2PSParticipants(peers)
}

/**
 * Helper to process a batch of received L2PS transactions
 */
async function processReceivedTransactions(l2psUid: string, txs: any[], peerIdentity: string): Promise<void> {
    for (const txData of txs) {
        try {
            // Extract and validate L2PS transaction object
            const l2psTx = txData.encrypted_tx
            const originalHash = txData.original_hash

            if (!l2psTx || !originalHash || !l2psTx.hash || !l2psTx.content) {
                log.debug(`[L2PS-SYNC] Invalid transaction structure received from ${peerIdentity}`)
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
