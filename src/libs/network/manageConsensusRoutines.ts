import { RPCResponse, VoteRequest } from "@kynesyslabs/demosdk/types"
import getCommonValidatorSeed from "../consensus/v2/routines/getCommonValidatorSeed"
import { emptyResponse } from "./server_rpc"
import _ from "lodash"
import ServerHandlers from "./endpointHandlers"
import sharedState from "src/utilities/sharedState"
import getShard from "../consensus/v2/routines/getShard"
import { Peer } from "../peer"
import manageProposeBlockHash from "../consensus/v2/routines/manageProposeBlockHash"
import { ValidationData } from "../consensus/v2/interfaces"
import ShardManager, { ValidatorStatus } from "../consensus/v2/routines/shardManager"
import { checkConsensusTime } from "../consensus/routines/consensusTime"
import { consensusRoutine, isConsensusAlreadyRunning } from "../consensus/v2/PoRBFT"
import log from "src/utilities/logger"

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
        response.response = "Consensus time not reached (checked by manageConsensusRoutines)"
        response.extra = "not in consensus"
        return response // ? Should we add some info about our delta time?
    } else {
        if (!isConsensusAlreadyRunning()) {
            //log.info("[manageConsensusRoutines] Starting the consensus routine as we are in consensus time window but not in consensus mode yet")
            consensusRoutine() // Asynchronous function     to avoid blocking the main thread
        }
        log.info("[manageConsensusRoutines] We are within the consensus time window")
    }

    // Also refuses the routine if we are not in the shard
    const shard = await getShard(sharedState.getInstance().currentValidatorSeed)
    const ourId = sharedState
        .getInstance()
        .identity.ed25519.publicKey.toString("hex")
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
        case "getValidatorTimestamp":
            response.result = 200
            // REVIEW Using the current UTC time as the validator timestamp (affect average time of the blocks)
            response.response = sharedState.getInstance().currentUTCTime //.lastTimestamp
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
            response.response = sharedState.getInstance().currentValidatorSeed
            break

        // SECTION Shard management
        // ! Add authentication to these methods
        case "getShard":
            //console.log("[Consensus Message Received] getShard")
            response.result = 200
            response.response = ShardManager.getInstance().getShard()
            console.log("[Consensus Message Received] getShard sent back")
            break
        case "setValidatorStatus":
            console.log("[Consensus Message Received] setValidatorStatus")
            // This call requires public key as string and status as ValidatorStatus
            var setResult = ShardManager.getInstance().setValidatorStatus(payload.params[0] as string, payload.params[1] as ValidatorStatus)
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
            response.response = ShardManager.getInstance().getValidatorStatus(payload.params[0] as string)
            console.log("[Consensus Message Received] getValidatorStatus sent back")
            break
    }

    return response
}
