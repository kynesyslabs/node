import { Peer, PeerManager } from "../peer"
import Block from "../blockchain/block"
import Chain from "../blockchain/chain"
import { syncBlock } from "../blockchain/routines/Sync"
import { RPCRequest } from "@kynesyslabs/demosdk/types"
import log from "src/utilities/logger"
import { getSharedState } from "@/utilities/sharedState"

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
        log.only("BROADCASTING NEW BLOCK TO THE NETWORK: " + block.number)
        const peerlist = PeerManager.getInstance().getPeers()
        log.only(
            "PEERLIST: " +
                JSON.stringify(
                    peerlist.map(p => p.connection.string),
                    null,
                    2,
                ),
        )

        // filter by block signers
        const peers = peerlist.filter(
            peer =>
                block.validation_data.signatures[peer.identity] == undefined,
        )
        log.only(
            "PEERS TO SEND TO: " +
                JSON.stringify(
                    peers.map(p => p.connection.string),
                    null,
                    2,
                ),
        )

        const promises = peers.map(peer => {
            const request: RPCRequest = {
                method: "gcr_routine",
                params: [{ method: "syncNewBlock", params: [block] }],
            }

            log.only("Sending to peer: " + peer.connection.string)
            return peer.longCall(request, true, 250, 3, [400])
        })

        const results = await Promise.all(promises)
        log.only("RESULTS: " + JSON.stringify(results, null, 2))
        const successful = results.filter(result => result.result === 200)

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
        log.only("HANDLING NEW BLOCK: " + block.number + " from: " + sender)
        // check if we already have the block
        const existing = await Chain.getBlockByHash(block.hash)
        log.only("EXISTING BLOCK: " + (existing ? "YES" : "NO"))
        if (existing) {
            return {
                result: 200,
                message: "Block already exists",
            }
        }

        const peer = PeerManager.getInstance().getPeer(sender)
        log.only("SYNCING BLOCK from PEER: " + peer.connection.string)
        const res = await syncBlock(block, peer)
        log.only("SYNC BLOCK RESULT: " + res ? "SUCCESS" : "FAILED")

        // REVIEW: Should we await this?
        await this.broadcastOurSyncData()

        return {
            result: res ? 200 : 400,
            message: res ? "Block synced successfully" : "Block sync failed",
        }
    }

    /**
     * Broadcasts our sync data to the network
     */
    static async broadcastOurSyncData() {
        log.only("BROADCASTING OUR SYNC DATA TO THE NETWORK")

        const peerlist = PeerManager.getInstance().getPeers()
        const promises = peerlist.map(peer => {
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

            return peer.longCall(request, true, 250, 3, [400])
        })

        const results = await Promise.all(promises)
        log.only("RESULTS: " + JSON.stringify(results, null, 2))
        const successful = results.filter(result => result.result === 200)
        if (successful.length > 0) {
            return true
        }

        return false
    }

    /**
     * Handles the update of the sync data from a peer
     *
     * @param sender The sender of the sync data
     * @param syncData The sync data to update
     */
    static async handleUpdatePeerSyncData(sender: string, syncData: string) {
        const ePeer = PeerManager.getInstance().getPeer(sender)

        if (!ePeer) {
            return {
                result: 400,
                message: "Peer not found",
            }
        }

        log.only(
            "HANDLING UPDATE PEER SYNC DATA: " + syncData + " from: " + sender,
        )
        const peer = new Peer(ePeer.connection.string, sender)

        const splits = syncData.trim().split(":")
        if (splits.length !== 3) {
            return {
                result: 400,
                message: "Invalid sync data",
            }
        }

        peer.sync.block = parseInt(splits[1])
        peer.sync.block_hash = splits[2]
        peer.sync.status = splits[0] === "1" ? true : false

        return {
            result: PeerManager.getInstance().addPeer(peer) ? 200 : 400,
            message: "Sync data updated",
        }
    }
}
