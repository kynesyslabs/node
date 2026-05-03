import log from "src/utilities/logger"
import Block from "../blockchain/block"
import Chain from "../blockchain/chain"
import { Peer, PeerManager } from "../peer"
import { syncBlock } from "../blockchain/routines/Sync"
import { RPCRequest } from "@kynesyslabs/demosdk/types"
import { Waiter } from "@/utilities/waiter"
import { getSharedState } from "@/utilities/sharedState"
import SecretaryManager from "../consensus/v2/types/secretaryManager"

/**
 * Manages the broadcasting of messages to the network
 */
export class BroadcastManager {
    /**
     * Broadcasts a new block to the network
     *
     * @param block The new block to broadcast
     */
    static async broadcastNewBlock(block: Block) {
        const peerlist = PeerManager.getInstance().getPeers()

        // filter by block signers
        const peers = peerlist.filter(
            peer =>
                block.validation_data.signatures[peer.identity] == undefined,
        )

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

        const responses = await Promise.all(promises)
        const successful = responses.filter(res => res.result.result === 200)

        for (const res of responses) {
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
    static async handleNewBlock(sender: string, block: Block) {
        const peerman = PeerManager.getInstance()

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

        // check if we already have the block
        const existing = await Chain.getBlockByHash(block.hash)
        if (existing) {
            return {
                result: 200,
                message: "Block already exists",
                syncData: peerman.ourSyncDataString,
            }
        }

        // check if we're in the consensus for received block
        const manager = SecretaryManager.getInstance(block.number)

        if (manager) {
            log.only("Received block while in consensus")

            return {
                result: 200,
                message: "Cannot process block, still in consensus",
                syncData: peerman.ourSyncData,
            }
        }

        const peer = peerman.getPeer(sender)
        const res = await syncBlock(block, peer)

        // REVIEW: Should we await this?
        await this.broadcastOurSyncData()

        return {
            result: res ? 200 : 400,
            message: res ? "Block synced successfully" : "Block sync failed",
            syncData: peerman.ourSyncDataString,
        }
    }

    /**
     * Broadcasts our sync data to the network
     */
    static async broadcastOurSyncData() {
        const peerlist = PeerManager.getInstance().getPeers()
        const promises = peerlist.map(async peer => {
            const request: RPCRequest = {
                method: "gcr_routine",
                params: [
                    {
                        method: "updateSyncData",
                        params: [
                            `${getSharedState.syncStatus ? "1" : "0"}:${
                                getSharedState.lastBlockNumber
                            }:${getSharedState.lastBlockHash}`,
                        ],
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

        const responses = await Promise.all(promises)
        const successful = responses.filter(res => res.result.result === 200)

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

        peer.sync.block = parseInt(splits[1])
        peer.sync.block_hash = splits[2]
        peer.sync.status = splits[0] === "1" ? true : false

        return {
            result: peerman.addPeer(peer) ? 200 : 400,
            message: "Sync data updated",
            syncData: peerman.ourSyncDataString,
        }
    }
}
