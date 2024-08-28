import { RPCRequest } from "@kynesyslabs/demosdk-http/types"
import { Peer } from "src/libs/peer"
import log from "src/utilities/logger"
import sharedState from "src/utilities/sharedState"

export interface ValidatorStatus {
    inConsensusLoop: boolean
    mergedMempool: boolean
    forgedBlock: boolean
    votedForBlock: boolean
}

const emptyValidatorStatus: ValidatorStatus = {
    inConsensusLoop: false,
    mergedMempool: false,
    forgedBlock: false,
    votedForBlock: false,
}

// This class is used to manage the shard and the validator statuses during the consensus routine.
// It is a singleton and relies on the server rpc to set the validator statuses (intra shard communication).
// ! It is checked by the consensus routine to ensure all nodes are in the right state at each step.
export default class ShardManager {
    private static instance: ShardManager
    private shard: Peer[] // The actual shard we are in

    // Each node has a status that we can track and query
    public shardStatus: Map<string, ValidatorStatus> // The status of the nodes in the shard

    private constructor() {}

    // Singleton logic
    public static getInstance(): ShardManager {
        if (!ShardManager.instance) {
            ShardManager.instance = new ShardManager()
        }
        return ShardManager.instance
    }

    // Destructor
    public static destroy() {
        ShardManager.instance = null
    }

    public setShard(shard: Peer[]) {
        this.shard = shard
        this.shardStatus = new Map<string, ValidatorStatus>()
        // Init to empty validator status
        for (let peer of this.shard) {
            this.shardStatus.set(peer.identity.toString("hex"), emptyValidatorStatus)
        }
    }

    public getShard() {
        return this.shard
    }

    // ! Do we need peer control or is that done by the consensus routines?
    public addToShard(peer: Peer) {
        this.shard.push(peer)
    }

    public setValidatorStatus(peer: string, status: ValidatorStatus) {
        // ! Identity checks or done by the server rpc?
        this.shardStatus.set(peer, status)
    }

    public getValidatorStatus(peer: string) {
        return this.shardStatus.get(peer)
    }

    public getOurValidatorStatus() {
        return this.shardStatus.get(sharedState.getInstance().identity.ed25519.publicKey.toString("hex"))
    }

    // Check if all nodes in the shard are in a specific status optionally forcing the check by calling the nodes
    public async checkShardStatus(status: ValidatorStatus, force: boolean = false) {
        for (let peer of this.shard) {
            log.info(`[shardManager] Checking the status of the node ${peer.identity.toString("hex")}`)
            // REVIEW If force is true, make a call to the node to get the status using getValidatorStatus
            if (force) {
                log.info(`[shardManager] Forcing recheck of the status of the node ${peer.identity.toString("hex")}`)
                let status = await peer.call({
                    method: "consensus_routine",
                    params: [{
                        method: "getValidatorStatus",
                        params: [peer.identity.toString("hex")],
                    }],
                }, true)
                // The above call returns a ValidatorStatus object so we can set it directly
                this.setValidatorStatus(peer.identity.toString("hex"), status.response)
            }
            // Check if the status is the same as the one in the shard status
            log.info(`[shardManager] Checking if the status of the node ${peer.identity.toString("hex")} is the same as the one in the shard status`)
            if (this.shardStatus.get(peer.identity.toString("hex")) !== status) {
                return false
            }
        }
        return true
    }

    // Utility to wait until the shard is ready in a set status
    public async waitUntilShardIsReady(status: ValidatorStatus, timeout: number = 2000): Promise<boolean> {
        log.info(`[shardManager] Waiting until the shard is ready in status: ${status}`)
        const startTime = Date.now()
        while (!this.checkShardStatus(status)) {
            if (Date.now() - startTime > timeout) {
                log.error(`[shardManager] Timeout while waiting for the shard to be ready in status: ${status}`)
                return false
            }
            await new Promise(resolve => setTimeout(resolve, 200))
        }
        log.info(`[shardManager] Shard is ready in status: ${status}`)
        return true
    }

    // Transmit our validator status to the shard
    public async transmitOurValidatorStatus() {
        log.info("[shardManager] Transmitting our validator status to the shard")
        // Prepare the call to the other nodes in the shard that show we are in the consensus loop
        let ourIdentity = sharedState.getInstance().identity.ed25519.publicKey.toString("hex")
        let validatorStatus = this.getValidatorStatus(ourIdentity)
        let statusCall: RPCRequest = {
            method: "consensus_routine",
            params: [{
                method: "setValidatorStatus",
                params: [ourIdentity, validatorStatus],
            }],
        }
        // Call every node in the shard that is not us to show we are in the consensus loop
        let promises = []
        for (let peer of this.shard) {
            if (peer.identity.toString("hex") !== ourIdentity) {
                promises.push(peer.call(statusCall, true))
            }
        }
        log.info("[shardManager] Our validator status has been transmitted to the shard: awaiting acknowledgement")
        await Promise.all(promises)
        log.info("[shardManager] Our validator status has been acknowledged by the shard")
    }
}