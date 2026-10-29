import log from "src/utilities/logger"
import Block from "../blockchain/block"
import Chain from "../blockchain/chain"
import { Peer, PeerManager } from "../peer"
import { RPCRequest, RPCResponse } from "@kynesyslabs/demosdk/types"
import { Waiter } from "@/utilities/waiter"
import { getSharedState } from "@/utilities/sharedState"
import SecretaryManager from "../consensus/v2/types/secretaryManager"
import { Mutex } from "async-mutex"
import GossipManager from "../gossip/GossipManager"
import { observeBlockFirstSeen } from "../gossip/metrics"
import {
    adoptCommittedBlock,
    checkConflictingBlock,
    scheduleHeightProbe,
} from "../consensus/v2/routines/committedBlock"

/**
 * Whether a peer took our sync data. Its handler answers inside a 200
 * envelope, and refuses a head it cannot corroborate yet (it is behind us)
 * with a 400 there: that peer must get the value again, both so it keeps
 * probing until it has caught up and so it then records where we are.
 */
function isSyncDataAccepted(reply: RPCResponse): boolean {
    return (
        reply?.result === 200 &&
        (reply.response as { result?: unknown } | null)?.result === 200
    )
}

/**
 *
 * Manages the broadcasting of messages to the network
 */
export class BroadcastManager {
    // Gossip publishes to the mesh, not to a peer, so it keeps one record
    private static lastBroadcastSyncData: string | null = null
    // Over HTTP each peer keeps its own: one that missed our head (it was
    // unreachable, or could not corroborate it yet) is sent it again rather
    // than skipped because the content did not change
    private static deliveredSyncData = new Map<string, string>()
    private static syncDataBroadcastInFlight = false
    private static syncDataBroadcastPending = false

    /**
     * Broadcasts a new block to the network
     *
     * @param block The new block to broadcast
     */
    static async broadcastNewBlock(block: Block) {
        // Gossip is the primary push path; the HTTP fan-out below only
        // runs when gossip is off or the mesh is not ready.
        if (GossipManager.isEnabled() && GossipManager.getInstance().isReady()) {
            log.debug(
                `[GOSSIP] routing block ${block.number} push over gossip`,
            )
            const published = await GossipManager.getInstance().publishBlock(
                block as never,
            )
            if (published) {
                await this.broadcastOurSyncData()
                return true
            }
        }

        log.debug(
            `[GOSSIP] routing block ${block.number} push over HTTP fan-out (gossip ${
                GossipManager.isEnabled() ? "not ready" : "disabled"
            })`,
        )
        // Signers are included: a member that signed this block can still have
        // failed its own tally, and without the block it would retry the height
        // and certify a second block there.
        const peers = PeerManager.getInstance().getPeers()

        if (peers.length === 0) {
            return
        }

        const promises = peers.map(async peer => {
            const request: RPCRequest = {
                method: "gcr_routine",
                params: [{ method: "syncNewBlock", params: [block] }],
            }

            return {
                pubkey: peer.identity,
                result: await peer.longCall(request, true, {
                    sleepTime: 250,
                    retries: 3,
                    allowedCodes: [400],
                }),
            }
        })

        type BroadcastResult = { pubkey: string; result: RPCResponse }
        const settled = await Promise.allSettled(promises)
        const responses = settled
            .filter(
                (r): r is PromiseFulfilledResult<BroadcastResult> =>
                    r.status === "fulfilled",
            )
            .map(r => r.value)
        const successful = responses.filter(res => res.result.result === 200)

        for (const res of responses) {
            if (res.result.result !== 200) continue
            await this.handleUpdatePeerSyncData(
                res.pubkey,
                res.result.response.syncData,
            )
        }

        await this.broadcastOurSyncData()

        if (successful.length > 0) {
            return true
        }

        return false
    }

    /**
     * Handles a new block received from the network
     *
     * @param block The new block received
     */
    static async handleNewBlock(
        sender: string,
        block: Block,
        source: "http" | "gossip" = "http",
    ) {
        log.debug("handleNewBlock called with block: " + block.number)
        const peerman = PeerManager.getInstance()

        if (block.number <= getSharedState.lastBlockNumber) {
            await this.checkBlockAtKnownHeight(sender, block)
            return {
                result: 200,
                message: "Block is already processed",
                syncData: peerman.ourSyncDataString,
            }
        }

        if (Waiter.isWaiting(Waiter.keys.SYNC_WAIT_FOR_BLOCK)) {
            Waiter.resolve(Waiter.keys.SYNC_WAIT_FOR_BLOCK, [
                block,
                peerman.getPeer(sender),
            ])

            return {
                result: 200,
                message: "Block received while waiting for next block",
                syncData: peerman.ourSyncDataString,
            }
        }

        if (!getSharedState.isInitialized) {
            return {
                result: 200,
                message: "Cannot handle new block. Node is not initialized",
                syncData: peerman.ourSyncDataString,
            }
        }

        // TODO: HANDLE RECEIVING THIS WHEN IN SYNC LOOP

        if (getSharedState.inSyncLoop) {
            return {
                result: 200,
                message: "Cannot handle new block when in sync loop",
                syncData: peerman.ourSyncDataString,
            }
        }

        // If block is greater than our last block + 1, exit
        if (block.number > getSharedState.lastBlockNumber + 1) {
            log.only("Block is greater than our last block + 1, ignoring it")
            scheduleHeightProbe(peerman.getPeer(sender), block.number)

            return {
                result: 200,
                message:
                    "Block is greater than our last block + 1, ignoring it",
                syncData: peerman.ourSyncDataString,
            }
        }

        // check if we already have the block
        const existing = await Chain.getBlockByHash(block.hash)
        if (existing) {
            return {
                result: 200,
                message: "Block already exists",
                syncData: peerman.ourSyncDataString,
            }
        }

        // A block committed by another member ends our own round for that
        // height: we hold syncLock, so the round finds the height filled when
        // it next checks and exits on ForgingEndedError.
        if (SecretaryManager.getInstance(block.number)) {
            log.info(
                `Received committed block ${block.number} while our round for it is live; adopting it if it verifies`,
            )
        }

        observeBlockFirstSeen(
            source,
            Math.max(0, Date.now() - (block.content?.timestamp ?? 0) * 1000),
        )

        // The committer may already be marked offline here (it can drop right
        // after its push), and its transactions are still fetched from it
        const peer = peerman.getPeer(sender) ?? peerman.getOfflinePeers()[sender]
        const outcome = await adoptCommittedBlock(block, peer)
        const res = outcome === "adopted" || outcome === "already-held"

        void this.broadcastOurSyncData()

        return {
            result: res ? 200 : 400,
            message: res ? "Block synced successfully" : "Block sync failed",
            syncData: peerman.ourSyncDataString,
        }
    }

    /**
     * A pushed block at a height we already hold: a different hash with a
     * verified quorum is a fork that must not pass silently.
     */
    static async checkBlockAtKnownHeight(sender: string, block: Block) {
        try {
            const ours = await Chain.getBlockByNumber(block.number)
            if (!ours || ours.hash === block.hash) return
            await checkConflictingBlock(ours, block, sender)
        } catch (e) {
            log.error(
                `[handleNewBlock] Conflict check of block ${block?.number} failed: ${e instanceof Error ? e.message : String(e)}`,
            )
        }
    }

    /**
     * Broadcasts our sync data to the network
     */
    static async broadcastOurSyncData() {
        if (BroadcastManager.syncDataBroadcastInFlight) {
            BroadcastManager.syncDataBroadcastPending = true
            return false
        }

        BroadcastManager.syncDataBroadcastInFlight = true
        try {
            let anySuccessful = false
            do {
                BroadcastManager.syncDataBroadcastPending = false
                const syncData = `${getSharedState.syncStatus ? "1" : "0"}:${
                    getSharedState.lastBlockNumber
                }:${getSharedState.lastBlockHash}`

                let successful = false
                if (
                    GossipManager.isEnabled() &&
                    GossipManager.getInstance().isReady()
                ) {
                    if (syncData !== BroadcastManager.lastBroadcastSyncData) {
                        log.debug(
                            `[GOSSIP] routing sync data over gossip: ${syncData}`,
                        )
                        successful = await GossipManager.getInstance()
                            .publishOwnHeights()
                            .catch(() => false)
                        // Marked only once published, so a failure is retried
                        if (successful) {
                            BroadcastManager.lastBroadcastSyncData = syncData
                        }
                    }
                } else {
                    successful =
                        await BroadcastManager.sendSyncDataToPeers(syncData)
                }
                anySuccessful = anySuccessful || successful
            } while (BroadcastManager.syncDataBroadcastPending)

            return anySuccessful
        } finally {
            BroadcastManager.syncDataBroadcastInFlight = false
        }
    }

    /**
     * Sends our sync data to each online peer that has not yet accepted this
     * exact value. A peer is marked only on an answer that took it; a peer
     * that went offline loses its mark, so it is sent our head again once it
     * is back, even if our head has not moved meanwhile.
     */
    private static async sendSyncDataToPeers(syncData: string) {
        const delivered = BroadcastManager.deliveredSyncData
        const online = PeerManager.getInstance().getPeers()
        const onlineIds = new Set(online.map(peer => peer.identity))
        for (const identity of [...delivered.keys()]) {
            if (!onlineIds.has(identity)) delivered.delete(identity)
        }
        const peerlist = online.filter(
            peer => delivered.get(peer.identity) !== syncData,
        )
        if (peerlist.length === 0) return false

        const promises = peerlist.map(async peer => {
            const request: RPCRequest = {
                method: "gcr_routine",
                params: [
                    {
                        method: "updateSyncData",
                        params: [syncData],
                    },
                ],
            }

            return {
                pubkey: peer.identity,
                result: await peer.longCall(request, true, {
                    sleepTime: 250,
                    retries: 3,
                    allowedCodes: [400],
                }),
            }
        })

        type SyncResult = { pubkey: string; result: RPCResponse }
        const settled = await Promise.allSettled(promises)
        const responses = settled
            .filter(
                (r): r is PromiseFulfilledResult<SyncResult> =>
                    r.status === "fulfilled",
            )
            .map(r => r.value)
        const successful = responses.filter(res => res.result.result === 200)

        for (const res of responses) {
            if (isSyncDataAccepted(res.result)) {
                delivered.set(res.pubkey, syncData)
            } else {
                delivered.delete(res.pubkey)
            }
        }

        for (const res of responses) {
            if (res.result.result !== 200) {
                continue
            }

            await this.handleUpdatePeerSyncData(
                res.pubkey,
                res.result.response.syncData,
            )
        }

        return successful.length > 0
    }

    /**
     * Handles the update of the sync data from a peer
     *
     * @param sender The sender of the sync data
     * @param syncData The sync data to update
     */
    static async handleUpdatePeerSyncData(sender: string, syncData: string) {
        const peerman = PeerManager.getInstance()
        const ePeer = peerman.getPeer(sender)

        if (!ePeer) {
            return {
                result: 400,
                message: "Peer not found",
            }
        }

        const peer = new Peer(ePeer.connection.string, sender)

        const splits = syncData ? syncData.trim().split(":") : []

        if (splits.length !== 3) {
            return {
                result: 400,
                message: "Invalid sync data",
                syncData: peerman.ourSyncDataString,
            }
        }

        const claimedBlock = parseInt(splits[1])
        const claimedHash = splits[2]

        // AUDIT H5 — do not accept a forged self-reported sync state. getShard
        // admits peers to the validator shard when their reported
        // (block, block_hash) matches our chain head, so an unverified claim
        // is shard-stuffing leverage. Validate the claim against OUR chain:
        //   - reject a block ahead of what we know (can't corroborate it);
        //   - for a height we have, reject a hash that disagrees with ours.
        // An honest synced peer reports our real head and still passes.
        if (!Number.isInteger(claimedBlock) || claimedBlock < 0) {
            return {
                result: 400,
                message: "Invalid sync block number",
                syncData: peerman.ourSyncDataString,
            }
        }

        if (claimedBlock > (getSharedState.lastBlockNumber ?? 0)) {
            scheduleHeightProbe(ePeer, claimedBlock, claimedHash)
            return {
                result: 400,
                message:
                    "Reported sync block is ahead of our chain; cannot corroborate",
                syncData: peerman.ourSyncDataString,
            }
        }

        const ourBlock = await Chain.getBlockByNumber(claimedBlock)
        if (!ourBlock || ourBlock.hash !== claimedHash) {
            scheduleHeightProbe(ePeer, claimedBlock, claimedHash)
            return {
                result: 400,
                message: "Reported sync block hash does not match our chain",
                syncData: peerman.ourSyncDataString,
            }
        }

        peer.sync.block = claimedBlock
        peer.sync.block_hash = claimedHash
        peer.sync.status = splits[0] === "1" ? true : false

        return {
            result: peerman.addPeer(peer) ? 200 : 400,
            message: "Sync data updated",
            syncData: peerman.ourSyncDataString,
        }
    }
}
