import { RPCRequest, RPCResponse } from "@kynesyslabs/demosdk/types"
import { getSharedState } from "src/utilities/sharedState"
import { emptyResponse } from "src/libs/network/server_rpc"
import _ from "lodash"
import { Peer } from "src/libs/peer"
import {
    emptyValidatorStatus,
    getShardManager,
    ValidatorStatus,
    ValidatorPhase,
    emptyValidatorPhase,
} from "./shardManager"
import log from "src/utilities/logger"
import { Cryptography } from "node_modules/@kynesyslabs/demosdk/build/encryption"
import { HexToForge } from "src/libs/crypto/forgeUtils"

/** NOTE
 * This class is used both by the secretary itself and the other shard partecipants.
 * The secretary will use it to update, retrieve and broadcast the statuses of the other shard partecipants.
 * The shard partecipants will use it as a local cache of the statuses of the other partecipants as stored in the secretary.
 */
class Secretary {
    private static instance: Secretary
    private secretary: Peer
    private status: Map<string, ValidatorStatus> = new Map()

    // REVIEW The below variables are used to avoid premature consensus end and to avoid nodes being left behind
    private phaseStatus: Map<string, ValidatorPhase> = new Map() // Map of the shard partecipants
    public consensusEnded: boolean = false

    constructor() {
        this.secretary = getShardManager.getShard()[0]
        log.custom(
            "secretary",
            "The secretary for this shard round is: " + this.secretary.identity,
        )
        log.custom(
            "secretary",
            JSON.stringify(this.secretary, null, 2),
            false,
            true,
        )
        log.custom(
            "secretary",
            "The shard and secretary have been initialized using the following seed: " +
                getSharedState.lastShardSeed,
            false,
            true,
        )
        for (const peer of getShardManager.getShard()) {
            // Using a deep copy of the emptyValidatorStatus to avoid any reference issues
            if (!this.status.has(peer.identity)) {
                this.status.set(
                    peer.identity,
                    _.cloneDeep(emptyValidatorStatus),
                )
            }
            // Initializing the waitStatus map
            this.phaseStatus.set(
                peer.identity,
                _.cloneDeep(emptyValidatorPhase),
            )
        }
    }

    public static getInstance(): Secretary {
        if (!Secretary.instance) {
            Secretary.instance = new Secretary()
        }
        return Secretary.instance
    }

    // REVIEW Authenticated endpoint to update the last seen time of a shard partecipant
    public updateLastSeen(peerKey: string, signature: string): void {
        // Checking the signature against the peerKey
        let isValid = Cryptography.verify(
            peerKey,
            HexToForge(signature),
            HexToForge(peerKey),
        )
        if (!isValid) {
            return
        }
        // Updating the last seen time
        // Updating the enteredConsensus flag and the consensusEnterTime, as well as the lastSeen time
        if (this.phaseStatus.get(peerKey).waitStatus) {
            if (!this.phaseStatus.get(peerKey).enteredConsensus) {
                log.custom(
                    "secretary",
                    "The validator " +
                        peerKey +
                        " has entered consensus at " +
                        getSharedState.currentTimestamp,
                )
                this.phaseStatus.get(peerKey).enteredConsensus = true
                this.phaseStatus.get(peerKey).consensusEnterTime =
                    getSharedState.currentTimestamp
            }
            log.custom(
                "secretary",
                "The validator " +
                    peerKey +
                    " last seen time has been updated to " +
                    getSharedState.currentTimestamp,
                true,
                false,
            )
            this.phaseStatus.get(peerKey).lastSeen =
                getSharedState.currentTimestamp
        }
    }

    // REVIEW Authenticated endpoint to set the waitStatus of a shard partecipant
    public setWaitStatus(
        peerKey: string,
        waitStatus: boolean,
        signature: string,
    ): Boolean {
        console.log(
            "[setWaitStatus] Received setWaitStatus request: processing",
        )
        // Checking the signature against the peerKey
        let isValid = Cryptography.verify(
            peerKey,
            HexToForge(signature),
            HexToForge(peerKey),
        )
        if (!isValid) {
            log.warning(
                `[setWaitStatus] Invalid signature for peer ${peerKey}`,
                true,
            )
            return false
        }
        console.log("[setWaitStatus] The wait status request seems valid")
        // Ensuring the peerKey is in the statuses
        if (!this.phaseStatus.has(peerKey)) {
            this.phaseStatus.set(peerKey, _.cloneDeep(emptyValidatorPhase))
        }
        this.phaseStatus.get(peerKey).waitStatus = waitStatus
        log.custom(
            "secretary",
            "The wait status has been updated for " +
                peerKey +
                " to " +
                waitStatus,
            true,
            false,
        )
        return true
    }

    // Setting the status of a shard partecipant
    // ! We need authentication for this
    public setStatus(peerKey: string, status: ValidatorStatus): RPCResponse {
        let response: RPCResponse = _.cloneDeep(emptyResponse)
        // Creating a deep copy of the status if it is not yet in the map
        if (!this.status.has(peerKey)) {
            this.status.set(peerKey, _.cloneDeep(emptyValidatorStatus))
        }
        // Setting the status
        this.status.set(peerKey, status)
        response.result = 200
        response.response = this.status
        response.extra = getSharedState.currentTimestamp
        log.custom(
            "secretary",
            "The status has been updated for " +
                peerKey +
                " with the following status: " +
                JSON.stringify(status, null, 2),
            false,
            true,
        )
        return response
    }

    // Setting the status of all the shard partecipants
    // ! We need authentication for this
    public setAllStatus(
        status: Map<string, ValidatorStatus>,
    ): Map<string, ValidatorStatus> {
        this.status = status
        log.custom(
            "secretary",
            "The status has been updated for all the shard with the following status: " +
                JSON.stringify(status, null, 2),
            false,
            true,
        )
        return this.getAllStatus()
    }

    // Getting the status of a shard partecipant
    // ! We need authentication for this
    public getStatus(peerKey: string): ValidatorStatus {
        log.custom(
            "secretary",
            "The status has been retrieved for " +
                peerKey +
                " with the following status: " +
                JSON.stringify(this.status.get(peerKey), null, 2),
            false,
            true,
        )
        return this.status.get(peerKey)
    }

    // Getting the status of all the shard partecipants
    // ! We need authentication for this
    public getAllStatus(): Map<string, ValidatorStatus> {
        log.custom(
            "secretary",
            "The status has been retrieved for all the shard with the following status: ",
            true,
            true,
        )
        console.log(this.status)
        return this.status
    }

    /* SECTION Control methods */

    // REVIEW This will be used to check if the consensus has ended by all the shard partecipants
    public isConsensusEnded(): [boolean, string[]] {
        // Returns a boolean and the list of validators that have not ended the consensus
        // TODO Implement this
        let notEndedValidators: string[] = []
        if (this.consensusEnded) {
            return [true, notEndedValidators]
        }
        // Checking if there are any validators that have not ended the consensus
        for (const [index, phase] of this.phaseStatus.entries()) {
            let validatorKey = Array.from(this.phaseStatus.keys())[index]
            if (!phase.readyToEndConsensus) {
                notEndedValidators.push(validatorKey)
            }
        }
        log.custom(
            "secretary",
            "The list of validators that have not ended the consensus is: " +
                JSON.stringify(notEndedValidators, null, 2),
        )
        // If there are no validators that have not ended the consensus, the consensus has ended
        if (notEndedValidators.length === 0) {
            this.consensusEnded = true
            return [true, notEndedValidators]
        }
        // If there are validators that have not ended the consensus, return false and the list of validators that have not ended the consensus
        return [false, notEndedValidators]
    }

    // REVIEW This will be used to check if there is someone waiting for the status update
    public isSomeoneWaiting(): [boolean, string[]] {
        let waitingValidators: string[] = []
        for (const [index, phase] of this.phaseStatus.entries()) {
            let validatorKey = Array.from(this.phaseStatus.keys())[index]
            if (phase.waitStatus) {
                waitingValidators.push(validatorKey)
            }
        }
        log.custom(
            "secretary",
            "The list of validators that are waiting for the status update is: " +
                JSON.stringify(waitingValidators, null, 2),
        )
        return [waitingValidators.length > 0, waitingValidators]
    }

    // REVIEW This will be used to end the consensus for a shard partecipant
    public readyToEndConsensus(peerKey: string, signature: string): boolean {
        // Checking the signature against the peerKey
        let isValid = Cryptography.verify(
            peerKey,
            HexToForge(signature),
            HexToForge(peerKey),
        )
        if (!isValid) {
            return false
        }
        // Setting the readyToEndConsensus flag to true
        this.phaseStatus.get(peerKey).readyToEndConsensus = true
        // ? Do we need to put here the check for the consensus ended that will make the Secretary broadcast the consensus ended message?
        log.custom(
            "secretary",
            "The ready to end consensus flag has been updated for " +
                peerKey +
                " to true",
        )
        return true
    }

    // REVIEW This will be used to broadcast the status of the shard members to the waiting shard members
    public async hitWaitingShardMembers(): Promise<[boolean, string[]]> { // Success + peers hit
        let waitingShardMembers: Peer[] = []
        let waitingShardMembersRequest = this.isSomeoneWaiting()
        let routineResponse: [boolean, string[]] = [true, []]
        // If there are shard members waiting for the status update, we hit them
        if (!waitingShardMembersRequest[0]) {
            return routineResponse
        }
        // Extracting the keys of the shard members that are waiting
            let waitingShardMembersKeys = waitingShardMembersRequest[1]
            // Getting the shard members
            let shardMembers = getShardManager.getShard()
            // Finding the shard members that are waiting and adding them to the list as Peer objects
            for (const peerKey of waitingShardMembersKeys) {
                let peer = shardMembers.find(peer => peer.identity === peerKey)
                waitingShardMembers.push(peer)
            }
            let currentStatus = this.getAllStatus()
            // Preparing the json call to broadcast the status of the shard members to the waiting shard members
            let jsonCall: RPCRequest = {
                method: "consensus_routine",
                params: [
                    {
                        method: "broadcastShardStatus",
                        params: [currentStatus],
                    },
                ],
            }
            // Broadcasting the status of the shard members to the waiting shard members
            let promises: Promise<RPCResponse>[] = []
            for (const peer of waitingShardMembers) {
                promises.push(peer.authenticatedCall(jsonCall))
                routineResponse[1].push(peer.identity)
            }
        // ? Do we need a check here to see the responses?
        // Waiting for the calls to finish and returning a recap of what happened
        await Promise.all(promises)
        return routineResponse
    }
}

export default Secretary
