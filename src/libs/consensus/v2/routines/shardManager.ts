import { RPCRequest } from "@kynesyslabs/demosdk/types"
import _ from "lodash"
import { Peer } from "src/libs/peer"
import log from "src/utilities/logger"
import { getSharedState } from "src/utilities/sharedState"

export interface ValidatorStatus {
    inConsensusLoop: boolean
    synchronizedTime: boolean
    mergedMempool: boolean
    forgedBlock: boolean
    votedForBlock: boolean
    mergedPeerlist: boolean
}

const emptyValidatorStatus: ValidatorStatus = {
    inConsensusLoop: false,
    synchronizedTime: false,
    mergedMempool: false,
    forgedBlock: false,
    votedForBlock: false,
    mergedPeerlist: false,
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
            this.shardStatus.set(peer.identity, _.cloneDeep(emptyValidatorStatus))
        }
        // Logging the shard
        log.custom(
            "last_shard",
            JSON.stringify(this.shard, null, 2),
            false,
            true,
        )
    }

    public getShard() {
        return this.shard
    }

    // ! Do we need peer control or is that done by the consensus routines?
    public addToShard(peer: Peer) {
        this.shard.push(peer)
    }

    public setValidatorStatus(
        peer: string,
        status: ValidatorStatus,
    ): [boolean, string] {
        // ! Identity checks or done by the server rpc?
        if (!this.shardStatus) {
            log.error(
                "[shardManager] Shard status not set because the shard is not set",
            )
            return [false, "Shard status not set because the shard is not set"]
        }
        this.shardStatus.set(peer, status)
        // Logging the shard status
        let dump = ""
        for (let [key, value] of this.shardStatus.entries()) {
            dump += `${key}: ${JSON.stringify(value, null, 2)}\n`
        }
        log.custom("shard_status_dump", dump, false, true)
        return [true, ""]
    }

    public getValidatorStatus(peer: string) {
        return this.shardStatus.get(peer)
    }

    public getOurValidatorStatus() {
        return this.shardStatus.get(
            getSharedState.identity.ed25519.publicKey.toString("hex"),
        )
    }

    // Check if all nodes in the shard are in a specific status optionally forcing the check by calling the nodes
    public async checkShardStatus(
        status: ValidatorStatus,
        pull: boolean = true,
    ) {
        for (let peer of this.shard) {
            log.info(
                `[shardManager] Checking the status of the node ${peer.identity}`,
            )
            // REVIEW If pull is true, make a call to the node to get the status using getValidatorStatus
            if (pull) {
                log.info(
                    `[shardManager] Forcing recheck of the status of the node ${peer.identity}`,
                )
                let status = await peer.longCall(
                    {
                        method: "consensus_routine",
                        params: [
                            {
                                method: "getValidatorStatus",
                                params: [peer.identity],
                            },
                        ],
                    },
                    true,
                ) // REVIEW  We should wait a little if the call returns false as the node is not in the consensus loop yet and in general for all consensus_routine calls
                // The above call returns a ValidatorStatus object so we can set it directly
                this.setValidatorStatus(peer.identity, status.response)
            }
            // Check if the status is the same as the one in the shard status
            log.info(
                `[shardManager] Checking if the status of the node ${peer.identity} is the same as the one in the shard status`,
            )

            // For every true value in the status, check if the peer status has the same true value
            // NOTE We don't really care about the false values as we might be in the process of doing something
            let peerStatus = this.shardStatus.get(peer.identity)
            for (let key in peerStatus) {
                if (status[key]) {
                    if (!peerStatus[key]) {
                        log.warning(
                            `[shardManager] The node ${peer.identity} specific value (${key}) is in the status: ${peerStatus[key]} and not in the status: ${status[key]}`,
                        )
                        return false
                    }
                }
            }

            /*if (this.shardStatus.get(peer.identity.toString("hex")) !== status) {
                return false
            } */
        }
        return true
    }

    // Utility to wait until the shard is ready in a set status
    public async waitUntilShardIsReady(
        status: ValidatorStatus,
        timeout: number = 3000,
        pull: boolean = false,
    ): Promise<boolean> {
        log.info(
            `[shardManager] Waiting until the shard is ready in status: ${status}`,
        )
        const startTime = Date.now()
        let checkStatus = this.checkShardStatus(status, pull)
        while (!checkStatus) {
            if (Date.now() - startTime > timeout) {
                log.error(
                    `[shardManager] Timeout while waiting for the shard to be ready in status: ${status}`,
                )
                return false
            }
            // Sleep for 500ms before checking again
            await new Promise(resolve => setTimeout(resolve, 500))
        }
        log.info(`[shardManager] Shard is ready in status: ${status}`)
        return true
    }

    // Transmit our validator status to the shard
    public async transmitOurValidatorStatus() {
        log.info(
            "[shardManager] Transmitting our validator status to the shard",
        )
        // Prepare the call to the other nodes in the shard that show we are in the consensus loop
        let ourIdentity =
            getSharedState.identity.ed25519.publicKey.toString("hex")
        let validatorStatus = this.getValidatorStatus(ourIdentity)
        let statusCall: RPCRequest = {
            method: "consensus_routine",
            params: [
                {
                    method: "setValidatorStatus",
                    params: [ourIdentity, validatorStatus],
                },
            ],
        } // REVIEW We should wait a little if the call returns false as the node is not in the consensus loop yet and in general for all consensus_routine calls
        // Call every node in the shard that is not us to show we are in the consensus loop
        let promises = []
        log.info("[shardManager] Shard peers: " + JSON.stringify(this.shard))
        for (let peer of this.shard) {
            if (peer.identity !== ourIdentity) {
                promises.push(peer.longCall(statusCall, true))
            }
        }
        log.info(
            "[shardManager] Our validator status has been transmitted to the shard: awaiting acknowledgement",
        )
        await Promise.all(promises)
        log.info(
            "[shardManager] Our validator status has been acknowledged by the shard",
        )
    }
}

// REVIEW Experimental singleton elegant approach
// Create an object with a getter
const shardManagerGetter = {
    get getShardManager() {
        return ShardManager.getInstance()
    },
}
// Export the getter object
export const { getShardManager } = shardManagerGetter
