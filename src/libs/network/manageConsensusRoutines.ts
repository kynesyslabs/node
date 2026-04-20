import { RPCResponse } from "@kynesyslabs/demosdk/types"
import getCommonValidatorSeed from "../consensus/v2/routines/getCommonValidatorSeed"
import { emptyResponse } from "./server_rpc"
import _ from "lodash"
import { getSharedState } from "src/utilities/sharedState"
import getShard from "../consensus/v2/routines/getShard"
import manageProposeBlockHash from "../consensus/v2/routines/manageProposeBlockHash"
import { ValidationData } from "../consensus/v2/interfaces"
import { checkConsensusTime } from "../consensus/routines/consensusTime"
import {
    consensusRoutine,
    isConsensusAlreadyRunning,
} from "../consensus/v2/PoRBFT"
import log from "src/utilities/logger"
import Cryptography from "../crypto/cryptography"
import SecretaryManager from "../consensus/v2/types/secretaryManager"
import { Waiter } from "src/utilities/waiter"
import { PeerManager } from "../peer"
import Chain from "../blockchain/chain"

export interface ConsensusMethod {
    method:
        | "vote"
        | "voteRequest"
        | "proposeBlockHash"
        | "broadcastBlock"
        | "getCommonValidatorSeed"
        | "getValidatorTimestamp"
        // REVIEW: Remove deprecated methods
        | "setValidatorPhase"
        | "getValidatorPhase"
        | "greenlight"
        | "getBlockTimestamp"
    params: any[]
}

export default async function manageConsensusRoutines(
    sender: string,
    payload: ConsensusMethod,
): Promise<RPCResponse> {
    log.debug("👍👍👍👍👍👍👍👍👍 RECEIVED CONSENSUS CALL 👍👍👍👍👍👍👍👍")

    const peer = PeerManager.getInstance().getPeer(sender)
    log.debug("Sender: " + peer.connection.string)
    log.debug("Payload: " + JSON.stringify(payload))
    log.debug("-----------------------------")
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

    log.debug("inConsensus: " + inConsensus)

    if (!inConsensus) {
        response.result = 400
        response.response =
            "Consensus time not reached (checked by manageConsensusRoutines)"
        response.extra = "not in consensus"
        return response // ? Should we add some info about our delta time?
    } else {
        if (!isConsensusAlreadyRunning()) {
            //log.info("[manageConsensusRoutines] Starting the consensus routine as we are in consensus time window but not in consensus mode yet")
            log.debug(
                "[manageConsensusRoutines] STARTING COSENSUS FROM CONSENSUS HANDLER",
            )
            consensusRoutine() // Asynchronous function     to avoid blocking the main thread
        }
        log.info(
            "[manageConsensusRoutines] We are within the consensus time window",
        )
    }

    // Also refuses the routine if we are not in the shard
    const { commonValidatorSeed } = await getCommonValidatorSeed()
    const shard = await getShard(commonValidatorSeed)
    const ourId = getSharedState.publicKeyHex
    let isInShard = false

    for (const peer of shard) {
        if (peer.identity === ourId) {
            isInShard = true
            break
        }
    }

    log.debug(`isInShard: ${isInShard}`)

    inShardCheck: if (!isInShard) {
        // INFO: If is a greenlight request, return 200
        if (payload.method === "greenlight") {
            // response.result = 200
            // response.response = "Greenlight received too late, ignoring"

            // return response
            break inShardCheck
        }

        if (payload.method === "setValidatorPhase") {
            // response.result = 200
            // response.response =
            //     "Set validator phase received too late, ignoring"
            // response.extra = {
            //     greenlight: true,
            // }
            // return response
            break inShardCheck
        }

        response.result = 400
        response.response =
            "We are not in the shard(" +
            getSharedState.exposedUrl +
            "), cannot proceed with the routine"

        log.error("🚒🚒🚒🚒🚒🚒🚒🚒🚒🚒🚒🚒🚒🚒🚒🚒🚒🚒🚒")
        log.error("Payload: " + JSON.stringify(payload))
        log.error(
            "We are not in the shard(" +
                getSharedState.exposedUrl +
                "), cannot proceed with the routine",
        )
        log.error("current validator seed: " + commonValidatorSeed)
        log.error(
            "calculated shard: " +
                JSON.stringify(
                    shard.map(m => m.connection.string),
                    null,
                    2,
                ),
        )
        const sharedStateLastShard = shard.map(m => m.connection.string)

        log.error(
            "shared state last shard: " + JSON.stringify(sharedStateLastShard),
        )
        log.error("last block number: " + getSharedState.lastBlockNumber)
        log.error("🚒🚒🚒🚒🚒🚒🚒🚒🚒🚒🚒🚒🚒🚒🚒🚒🚒🚒🚒")

        // INFO: Check if seed is from past consensus round
        // const lastBlockMinus1 = await Chain.getBlockByNumber(getSharedState.lastBlockNumber - 1)
        // const { commonValidatorSeed: pastCommonValidatorSeed } = await getCommonValidatorSeed(lastBlockMinus1)
        // if (pastCommonValidatorSeed == commonValidatorSeed) {
        //     log.error("Seed is from past consensus round")
        //     response.result = 400
        //     response.response = "Seed is from past consensus round"
        //     return response
        // }
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

        /* SECTION Secretary communication methods */
        // REVIEW The secretary should be able to communicate with the other shard members through these methods

        /* SECTION Consensus methods */

        case "getValidatorTimestamp":
            response.result = 200
            // REVIEW Using the current UTC time as the validator timestamp (affect average time of the blocks)
            response.response = getSharedState.currentUTCTime //.lastTimestamp
            return response

        case "proposeBlockHash": // For shard members to vote on a block hash
            log.debug(
                "[Consensus] Received proposeBlockHash - Hash: " +
                    payload.params[0],
            )
            log.debug(
                "[Consensus] Validation Data: " +
                    JSON.stringify(payload.params[1]),
            )
            // TODO
            // compare the block hash with the one we have and reply
            try {
                return await manageProposeBlockHash(
                    payload.params[0],
                    payload.params[1] as ValidationData,
                    payload.params[2] as string,
                )
            } catch (error) {
                log.error(
                    "[manageConsensusRoutines] Error proposing block hash: " +
                        error,
                )
            }

            // const r= manageProposeBlockHash(
            //     payload.params[0],
            //     payload.params[1] as ValidationData,
            //     payload.params[2] as string,
            // )
            break
        case "broadcastBlock": // For non shard members to get the block from the shard
            // TODO: Check if the block contains the validation data of the shard -> if it does, reply true and add the block to the chain
            break
        case "getCommonValidatorSeed":
            response.result = 200
            await getCommonValidatorSeed() // NOTE This is generated each time and stored in the shared state
            response.response = commonValidatorSeed
            break

        // SECTION: New Secretary Manager class handlers
        case "setValidatorPhase": {
            try {
                const [phase, seed, blockRef] = payload.params
                const manager = SecretaryManager.getInstance(blockRef)

                //INFO: If the manager class for that block is not found, assume peer is behind on the consensus
                // return a greenlight to unblock peer
                if (!manager) {
                    response.result = 200
                    response.response = "Secretary manager not found"
                    response.extra = {
                        greenlight: true,
                    }

                    return response
                }

                // INFO: Seed check
                if (
                    manager.shard?.blockRef === blockRef &&
                    seed !== manager.shard?.CVSA
                ) {
                    // TODO: Remove this block after testing!
                    // setTimeout(() => {
                    //     log.debug("our seed: " + manager.shard.CVSA)
                    //     log.debug(
                    //         "payload params: " +
                    //             JSON.stringify(payload.params, null, 2),
                    //     )
                    //     log.error("Invalid seed detected")
                    //     process.exit(0)
                    // }, 500)
                    // INFO: Logs parts used to create the current CVSA
                    await getCommonValidatorSeed(null, (message: string) => {
                        log.only(message)
                    })

                    return {
                        result: 200,
                        response: "Invalid seed detected",
                        extra: 450,
                        require_reply: false,
                    }
                }

                const peerKey = sender

                // INFO: If we receive a setValidatorPhase request, and the
                // secretary routine has not started, wait for it to start
                if (
                    !manager.runSecretaryRoutine ||
                    blockRef > manager.shard.blockRef
                ) {
                    try {
                        await Waiter.wait(
                            peerKey + Waiter.keys.WAIT_FOR_SECRETARY_ROUTINE,
                            3000,
                        )
                    } catch (error) {
                        log.error(
                            "[manageConsensusRoutines] Error waiting for the secretary routine to start: " +
                                error,
                        )

                        response.result = 500
                        response.response =
                            "Error waiting for the secretary routine to start"
                        return response
                    }
                }

                // INFO: Check if sender is in the consensus
                if (!manager.shard.members.some(m => m.identity === sender)) {
                    response.result = 401
                    response.response = "Sender not in the consensus"
                    response.extra = "Sender not in the consensus"
                    return response
                }

                if (blockRef < manager.shard.blockRef) {
                    response.result = 400
                    response.response =
                        "Block reference is lower than the current block reference"
                    return response
                }

                const isUs = peerKey === getSharedState.publicKeyHex
                log.debug(
                    "[Consensus Message Received] setValidatorPhase from: " +
                        peerKey,
                )
                log.debug("Is us: " + isUs)
                const data = await manager.receiveValidatorPhase(peerKey, phase)
                response.result = 200
                response.response = `Validator phase set to ${phase}`

                // INFO: Returning the greenlight status
                // NOTE: We also attach the block timestamp to the response
                data["timestamp"] = manager.blockTimestamp
                data["blockRef"] = manager.shard.blockRef
                response.extra = data
            } catch (error) {
                // INFO: Node is secretary, but hasn't started the secretary routine yet!
                // REVIEW: Should we start the secretary routine here?
                log.error(
                    "[manageConsensusRoutines] Error setting the validator phase: " +
                        error,
                )
                response.result = 500
                response.response = "Error setting the validator phase"
            }
            break
        }

        case "greenlight": {
            // TODO: Check if the sender is the secretary (without verifying the signature
            // as we have already done that) in validateHeaders
            const [blockRef, timestamp, validatorPhase] = payload.params as [
                number, // blockRef
                number, // timestamp
                number, // validatorPhase
            ]

            const manager = SecretaryManager.getInstance(blockRef)

            // INFO: If the manager class for that block is not found, assume peer is behind on the consensus
            // return a 200 to unblock peer
            if (!manager) {
                log.debug("returning a fake 200")
                response.result = 200
                response.response = "Secretary manager not found"
                return response
            }

            // INFO: Check if the sender is the secretary
            if (sender !== manager.secretary.identity) {
                log.debug("returning a 401")
                response.result = 401
                response.response = "Greenlight not accepted"
                response.extra = "Secretary identity mismatch"
                response.require_reply = false
                return response
            }

            // INFO: Act on the greenlight
            const greenLightReceived = manager.receiveGreenLight(
                timestamp,
                validatorPhase,
            )
            response.result = greenLightReceived ? 200 : 400
            response.response = greenLightReceived
                ? `Greenlight for phase: ${validatorPhase} received with block timestamp: ${timestamp}`
                : "Error receiving greenlight"
            break
        }

        // SECTION: Getter handlers
        // NOTE: Ideally, we should never need to use these methods
        case "getValidatorPhase": {
            const manager = SecretaryManager.getInstance()

            if (!manager) {
                response.result = 400
                response.response = [null]
                response.extra = { error: "Consensus not in progress" }
                return response
            }

            response.result = 200
            response.response = [manager.ourValidatorPhase.currentPhase]
            break
        }

        case "getBlockTimestamp": {
            const manager = SecretaryManager.getInstance()

            if (!manager) {
                response.result = 400
                response.response = [null]
                response.extra = { error: "Consensus not in progress" }
                return response
            }

            response.result = 200
            response.response = [manager.blockTimestamp]
            break
        }
    }

    return response
}
