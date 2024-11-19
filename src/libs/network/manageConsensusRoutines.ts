import { RPCResponse, VoteRequest } from "@kynesyslabs/demosdk/types"
import getCommonValidatorSeed from "../consensus/v2/routines/getCommonValidatorSeed"
import { emptyResponse } from "./server_rpc"
import _ from "lodash"
import ServerHandlers from "./endpointHandlers"
import sharedState, { getSharedState } from "src/utilities/sharedState"
import getShard from "../consensus/v2/routines/getShard"
import { Peer } from "../peer"
import manageProposeBlockHash from "../consensus/v2/routines/manageProposeBlockHash"
import { ValidationData } from "../consensus/v2/interfaces"
import {
    ValidatorStatus,
    getShardManager,
} from "../consensus/v2/routines/shardManager"
import { checkConsensusTime } from "../consensus/routines/consensusTime"
import {
    consensusRoutine,
    isConsensusAlreadyRunning,
} from "../consensus/v2/PoRBFT"
import log from "src/utilities/logger"
import Secretary from "../consensus/v2/routines/secretary"
import Cryptography from "../crypto/cryptography"
import { HexToForge } from "../crypto/forgeUtils"

export interface ConsensusMethod {
    method:
        | "vote"
        | "voteRequest"
        | "proposeBlockHash"
        | "broadcastBlock"
        | "getCommonValidatorSeed"
        | "getValidatorTimestamp"
        | "getShard"
        | "setValidatorStatus"
        | "getValidatorStatus"
        | "setSecretaryStatus"
        | "getSecretaryStatus"
        | "getSingleSecretaryStatus"
        | "setWaitStatus"
        | "updateLastSeen"
        | "broadcastedConsensusEnd"
        | "readyToEndConsensus"
        | "broadcastShardStatus"
    params: any[]
}

export default async function manageConsensusRoutines(
    payload: ConsensusMethod,
): Promise<RPCResponse> {
    let response = _.cloneDeep(emptyResponse)

    /* REVIEW
    We allow incoming requests when we are within the consensus time window.
    If we are not in consensus mode, we start the consensus mode and then execute the request.
    This should not conflict with mainLoop as the semaphore will prevent the execution of two
    consensus routines at the same time.
    Also this should make so that within the time window all the shard members are in consensus mode.
    */
    // If the consensus is already running, we do not need to check the time again
    // ! When we return false, we cannot have the client asking for the same method over and over again or
    // ! continue asking for consensus_routine, we must rate limit the requests
    const isConsensusTime = await checkConsensusTime(true, 2)
    const isConsensusRunning = isConsensusAlreadyRunning()
    const inConsensus = isConsensusTime || isConsensusRunning
    if (!inConsensus) {
        log.error("[manageConsensusRoutines] Consensus time not reached")
        response.result = 400
        response.response =
            "Consensus time not reached (checked by manageConsensusRoutines)"
        response.extra = "not in consensus"
        return response // ? Should we add some info about our delta time?
    } else {
        if (!isConsensusAlreadyRunning()) {
            //log.info("[manageConsensusRoutines] Starting the consensus routine as we are in consensus time window but not in consensus mode yet")
            consensusRoutine() // Asynchronous function     to avoid blocking the main thread
        }
        log.info(
            "[manageConsensusRoutines] We are within the consensus time window",
        )
    }

    // Also refuses the routine if we are not in the shard
    const shard = await getShard(getSharedState.currentValidatorSeed)
    const ourId = getSharedState.identity.ed25519.publicKey.toString("hex")
    let isInShard = false
    for (const peer of shard) {
        if (peer.identity == ourId) {
            isInShard = true
            break
        }
    }
    if (!isInShard) {
        response.result = 400
        response.response =
            "We are not in the shard, cannot proceed with the routine"
        return response
    }
    // NOTE Each method has its own logic to be implemented
    switch (payload.method) {
        /*
        // ANCHOR Old methods for consensus v1
        case "vote":
            return await manageVote(
                payload.params[0] as VoteRequest,
                payload.params[1] as (response: RPCResponse) => void,
            )
        case "voteRequest":
            return await ServerHandlers.handleVoteRequest(
                payload.params[0].timestamp,
            )
        */

        // ANCHOR New methods for consensus v2

        // REVIEW Secretary system

        /* SECTION Secretary control methods */

        // Authenticated endpoint to set the wait status
        /** REVIEW Shard members will use this endpoint to set their status into a waiting state.
         * This should allow the secretary to know when all the shard members are ready to proceed and use
         * the broadcastedConsensusEnd or broadcastShardStatus methods to control other members' behaviour.
         */
        /**
         * @param payload.params[0] - The public key of the peer
         * @param payload.params[1] - The wait status
         * @param payload.params[2] - The signature of the public key
         */
        case "setWaitStatus":
            response.result = 200
            log.custom(
                "secretary",
                "Received setWaitStatus request from " +
                    payload.params[0] +
                    " with wait status " +
                    payload.params[1] +
                    " and signature " +
                    payload.params[2],
                true,
                false,
            )
            response.response = Secretary.getInstance().setWaitStatus(
                payload.params[0] as string, // Public key of the peer
                payload.params[1] as boolean, // Wait status
                payload.params[2] as string, // Signature of the public key
            )
            break
        // Authenticated endpoint to update the last seen time
        case "updateLastSeen":
            response.result = 200
            response.response = Secretary.getInstance().updateLastSeen(
                payload.params[0] as string, // Public key of the peer
                payload.params[1] as string, // Signature of the public key
            )
            break

        // Authenticated endpoint to set our ready to end consensus status
        case "readyToEndConsensus":
            response.result = 200
            response.response = Secretary.getInstance().readyToEndConsensus(
                payload.params[0] as string, // Public key of the peer
                payload.params[1] as string, // Signature of the public key
            )
            break

        // ! We need authentication for this
        case "setSecretaryStatus":
            response.result = 200
            response.response = Secretary.getInstance().setStatus(
                payload.params[0] as string,
                payload.params[1] as ValidatorStatus,
            )
            break
        // ! We need authentication for this
        case "getSecretaryStatus":
            response.result = 200
            response.response = Secretary.getInstance().getAllStatus()
            break

        case "getSingleSecretaryStatus":
            response.result = 200
            response.response = Secretary.getInstance().getStatus(
                payload.params[0] as string,
            )
            break

        /* SECTION Secretary local methods */

        /* SECTION Secretary communication methods */
        // REVIEW The secretary should be able to communicate with the other shard members through these methods

        /** TODO
         * This method is called by the secretary when the consensus has ended for all shard partecipants
         * Once received, the shard partecipant will be able to tell that everyone has ended the consensus and will proceed
         */
        case "broadcastedConsensusEnd":
            response.result = 200
            // TODO Implement this
            break

        // REVIEW Receiving a broadcasted shard status (Map<string, ValidatorStatus>)
        /** NOTE
         * This endpoint is hit by the secretary when a shard member is waiting for something
         * and the secretary is broadcasting the status of the shard members to let it know that
         * the shard members are ready to proceed (or not).
         */
        case "broadcastShardStatus":
            // The status is received from the secretary so we need to verify the signature
            var receivedKey = payload.params[0] as string
            var receivedSignature = payload.params[1] as string
            // Getting the secretary public key
            var currentShard = await getShard(
                getSharedState.currentValidatorSeed,
            ) // REVIEW Is this correct?
            var secretaryKey = currentShard[0].identity
            // First we verify the key corresponds to the secretary
            if (receivedKey !== secretaryKey) {
                response.result = 400
                response.response = "invalid key"
                response.extra = "Secretary key mismatch"
                return response
            }
            // Verifying the signature
            var isSignatureValid = await Cryptography.verify(
                secretaryKey,
                HexToForge(receivedSignature),
                HexToForge(secretaryKey),
            )
            if (!isSignatureValid) {
                response.result = 400
                response.response = "invalid signature"
                response.extra = "Signature verification failed"
                return response
            }
            // Ingesting the payload
            var receivedStatus = payload.params[1] as Map<
                string,
                ValidatorStatus
            >
            // TODO Implement this
            response.result = 400
            response.response = "Not implemented"
            break

        /* SECTION Consensus methods */

        case "getValidatorTimestamp":
            response.result = 200
            // REVIEW Using the current UTC time as the validator timestamp (affect average time of the blocks)
            response.response = getSharedState.currentUTCTime //.lastTimestamp
            return response
        case "proposeBlockHash": // For shard members to vote on a block hash
            console.log("[Consensus Message Received] Propose Block Hash")
            console.log("Block Hash: ", payload.params[0])
            console.log("Validation Data: ", payload.params[1])
            // TODO
            // compare the block hash with the one we have and reply
            return await manageProposeBlockHash(
                payload.params[0],
                payload.params[1] as ValidationData,
                payload.params[2] as string,
            )
        case "broadcastBlock": // For non shard members to get the block from the shard
            // TODO: Check if the block contains the validation data of the shard -> if it does, reply true and add the block to the chain
            break
        case "getCommonValidatorSeed":
            response.result = 200
            await getCommonValidatorSeed() // NOTE This is generated each time and stored in the shared state
            response.response = getSharedState.currentValidatorSeed
            break

        // SECTION Shard management
        // ! Add authentication to these methods
        case "getShard":
            //console.log("[Consensus Message Received] getShard")
            response.result = 200
            response.response = getShardManager.getShard()
            console.log("[Consensus Message Received] getShard sent back")
            break
        case "setValidatorStatus":
            console.log("[Consensus Message Received] setValidatorStatus")
            // This call requires public key as string and status as ValidatorStatus
            var setResult = getShardManager.setValidatorStatus(
                payload.params[0] as string,
                payload.params[1] as ValidatorStatus,
            )
            if (setResult[0]) {
                response.result = 200
                response.response = "Validator status set"
            } else {
                response.result = 400
                response.response = setResult[1]
            }
            break
        case "getValidatorStatus":
            //console.log("[Consensus Message Received] getValidatorStatus")
            response.result = 200
            response.response = getShardManager.getValidatorStatus(
                payload.params[0] as string,
            )
            console.log(
                "[Consensus Message Received] getValidatorStatus sent back",
            )
            break
    }

    return response
}
