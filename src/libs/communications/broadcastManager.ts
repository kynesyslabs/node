import log from "src/utilities/logger"
import Block from "../blockchain/block"
import Chain from "../blockchain/chain"
import { Peer, PeerManager } from "../peer"
import { syncBlock } from "../blockchain/routines/Sync"
import { RPCRequest, RPCResponse } from "@kynesyslabs/demosdk/types"
import { Waiter } from "@/utilities/waiter"
import { getSharedState } from "@/utilities/sharedState"
import SecretaryManager from "../consensus/v2/types/secretaryManager"
import { Mutex } from "async-mutex"
import { Config } from "src/config"
import { MetricsService } from "src/features/metrics/MetricsService"
import {
    BlockSyncAggregateV1,
    admitSyncAggregate,
    buildSyncAggregate,
} from "./syncAggregation"

/**
 *
 * Manages the broadcasting of messages to the network
 */
export class BroadcastManager {
    private static syncAggregationEnabled(): boolean {
        return Config.getInstance().core.blockSyncAggregationEnabled
    }

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

        MetricsService.getInstance().incrementCounter(
            "messages_sent_total",
            { type: "syncNewBlock" },
            peers.length,
        )
        MetricsService.getInstance().incrementCounter(
            "block_sync_messages_sent_total",
            { kind: "syncNewBlock", source: "post_block" },
            peers.length,
        )

        type BroadcastResult = { pubkey: string; result: RPCResponse }
        const settled = await Promise.allSettled(promises)
        const responses = settled
            .filter(
                (r): r is PromiseFulfilledResult<BroadcastResult> =>
                    r.status === "fulfilled",
            )
            .map(r => r.value)
        const successful = responses.filter(res => res.result.result === 200)

        if (this.syncAggregationEnabled()) {
            const aggregate = buildSyncAggregate(
                block,
                getSharedState.publicKeyHex,
                responses,
            )
            // Apply the same aggregate locally before publishing it so the
            // block sender and recipients converge through one code path.
            this.applySyncAggregate(
                getSharedState.publicKeyHex,
                aggregate,
                block,
            )
            await this.broadcastSyncAggregate(aggregate)
        } else {
            for (const res of responses) {
                if (res.result.result !== 200) continue
                const body = res.result.response
                if (!body || typeof body !== "object") continue
                await this.handleUpdatePeerSyncData(
                    res.pubkey,
                    (body as { syncData?: string }).syncData,
                )
            }

            await this.broadcastOurSyncData("sender_post_block")
        }

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
        log.debug("handleNewBlock called with block: " + block.number)
        const peerman = PeerManager.getInstance()

        if (block.number <= getSharedState.lastBlockNumber) {
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

        // If we signed the block, exit
        if (block.validation_data.signatures[getSharedState.publicKeyHex]) {
            log.only("Block is already signed by us, ignoring it")
            return {
                result: 200,
                message: "Block is already signed by us, ignoring it",
                syncData: peerman.ourSyncDataString,
            }
        }

        // If block is greater than our last block + 1, exit
        if (block.number > getSharedState.lastBlockNumber + 1) {
            log.only("Block is greater than our last block + 1, ignoring it")

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

        // check if we're in the consensus for received block
        const manager = SecretaryManager.getInstance(block.number)

        if (manager) {
            log.debug("Received block while in consensus")

            return {
                result: 200,
                message: "Cannot process block, still in consensus",
                syncData: peerman.ourSyncDataString,
            }
        }

        const peer = peerman.getPeer(sender)
        const res = await syncBlock(block, peer)

        // Legacy behaviour fans each recipient's status back out to every
        // peer. The POC returns the same syncData in this response and lets
        // the block sender publish one aggregate instead. Existing hello and
        // peer-gossip routines remain the anti-entropy recovery path.
        if (!this.syncAggregationEnabled()) {
            await this.broadcastOurSyncData("receiver_post_block")
        }

        return {
            result: res ? 200 : 400,
            message: res ? "Block synced successfully" : "Block sync failed",
            syncData: peerman.ourSyncDataString,
        }
    }

    /**
     * Broadcasts our sync data to the network
     */
    static async broadcastOurSyncData(source = "anti_entropy") {
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

        type SyncResult = { pubkey: string; result: RPCResponse }
        const settled = await Promise.allSettled(promises)
        MetricsService.getInstance().incrementCounter(
            "messages_sent_total",
            { type: "updateSyncData" },
            peerlist.length,
        )
        MetricsService.getInstance().incrementCounter(
            "block_sync_messages_sent_total",
            { kind: "updateSyncData", source },
            peerlist.length,
        )
        const responses = settled
            .filter(
                (r): r is PromiseFulfilledResult<SyncResult> =>
                    r.status === "fulfilled",
            )
            .map(r => r.value)
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

    /** Publish one compact acknowledgement set for a consensus-approved block. */
    static async broadcastSyncAggregate(aggregate: BlockSyncAggregateV1) {
        const peerlist = PeerManager.getInstance()
            .getPeers()
            .filter(
                peer =>
                    peer.identity.toLowerCase() !==
                    getSharedState.publicKeyHex.toLowerCase(),
            )

        const settled = await Promise.allSettled(
            peerlist.map(peer => {
                // Authenticated calls add their envelope to params, so each
                // concurrent peer must receive an independent request object.
                const request: RPCRequest = {
                    method: "gcr_routine",
                    params: [
                        {
                            method: "updateSyncAggregate",
                            params: [aggregate],
                        },
                    ],
                }
                return peer.longCall(request, true, {
                    sleepTime: 250,
                    retries: 2,
                    allowedCodes: [400],
                })
            }),
        )
        MetricsService.getInstance().incrementCounter(
            "messages_sent_total",
            { type: "updateSyncAggregate" },
            peerlist.length,
        )
        MetricsService.getInstance().incrementCounter(
            "block_sync_messages_sent_total",
            { kind: "updateSyncAggregate", source: "sender_post_block" },
            peerlist.length,
        )

        return settled.filter(
            result =>
                result.status === "fulfilled" && result.value.result === 200,
        ).length
    }

    /**
     * Apply a bounded block-signer observation. This POC deliberately treats
     * the aggregate as a liveness hint: it can only advance known peers to an
     * already verified local block and never marks a peer online.
     */
    static async handleSyncAggregate(
        sender: string,
        value: unknown,
    ): Promise<{
        result: number
        message: string
        accepted: number
        syncData: string
    }> {
        const rawBlockNumber =
            value &&
            typeof value === "object" &&
            typeof (value as { blockNumber?: unknown }).blockNumber === "number"
                ? (value as { blockNumber: number }).blockNumber
                : -1
        const blockNumber =
            Number.isSafeInteger(rawBlockNumber) &&
            rawBlockNumber >= 0 &&
            rawBlockNumber <= getSharedState.lastBlockNumber
                ? rawBlockNumber
                : -1
        const block =
            blockNumber >= 0 ? await Chain.getBlockByNumber(blockNumber) : null
        return this.applySyncAggregate(sender, value, block)
    }

    private static applySyncAggregate(
        sender: string,
        value: unknown,
        block: Block | null,
    ): {
        result: number
        message: string
        accepted: number
        syncData: string
    } {
        const peerman = PeerManager.getInstance()
        const syncData = peerman.ourSyncDataString
        const admission = admitSyncAggregate(
            value,
            block,
            sender,
            getSharedState.publicKeyHex,
            peerman.getPeers().map(peer => peer.identity),
        )
        if ("status" in admission) {
            return {
                result: admission.status,
                message: admission.message,
                accepted: 0,
                syncData,
            }
        }

        let accepted = 0
        for (const identity of admission.acceptedPeerIds) {
            const existing = peerman
                .getPeers()
                .find(peer => peer.identity.toLowerCase() === identity)
            if (!existing) continue
            const changed =
                !existing.sync.status ||
                existing.sync.block !== block.number ||
                existing.sync.block_hash !== block.hash
            // The PeerManager returns live Peer objects. Mutating only the
            // sync hint avoids touching connection, authentication, or online
            // status while also correcting a same-height conflicting hash.
            existing.sync.status = true
            existing.sync.block = block.number
            existing.sync.block_hash = block.hash
            if (changed) accepted++
        }

        return {
            result: 200,
            message: "Sync aggregate applied",
            accepted,
            syncData: peerman.ourSyncDataString,
        }
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
            return {
                result: 400,
                message:
                    "Reported sync block is ahead of our chain; cannot corroborate",
                syncData: peerman.ourSyncDataString,
            }
        }
        const ourBlock = await Chain.getBlockByNumber(claimedBlock)
        if (!ourBlock || ourBlock.hash !== claimedHash) {
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
