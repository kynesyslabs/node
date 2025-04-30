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

        /* SECTION Secretary communication methods */
        // REVIEW The secretary should be able to communicate with the other shard members through these methods

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
            try {
                response = await manageProposeBlockHash(
                    payload.params[0],
                    payload.params[1] as ValidationData,
                    payload.params[2] as string,
                )
            } catch (error) {
                console.error(error)
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
            response.response = getSharedState.currentValidatorSeed
            break

        // SECTION: New Secretary Manager class handlers
        case "setValidatorPhase": {
            try {
                const [peerSignature, peerKey, phase, seed, blockRef] =
                    payload.params

                const manager = SecretaryManager.getInstance()

                // INFO: Seed check
                if (
                    manager.shard?.blockRef == blockRef &&
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

                // INFO: Authentication
                const isSignatureValid = Cryptography.verify(
                    peerKey,
                    peerSignature,
                    peerKey,
                )

                if (!isSignatureValid) {
                    response.result = 401
                    response.response = "Invalid signature"
                    response.extra = "Signature verification failed"
                    return response
                }

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

                if (blockRef < manager.shard.blockRef) {
                    response.result = 400
                    response.response =
                        "Block reference is lower than the current block reference"
                    return response
                }

                const isUs =
                    peerKey ===
                    getSharedState.identity.ed25519.publicKey.toString("hex")
                log.warning(
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
                console.error(error)
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
            const [secretarySignature, senderKey, timestamp, validatorPhase] =
                payload.params as [string, string, number, number]

            log.warning(
                "[Consensus Message Received] greenlight from: " + senderKey,
            )
            log.info(
                "payload.params: " + JSON.stringify(payload.params, null, 2),
            )
            const manager = SecretaryManager.getInstance()

            log.debug("Our secretary identity: " + manager.secretary.identity)
            log.debug("Received secretary signature: " + secretarySignature)
            log.debug("shard: " + manager.shard.members.map(m => m.identity))

            // INFO: Check if the request came from our secretary
            const isOurSecretary = Cryptography.verify(
                manager.secretary.identity,
                secretarySignature,
                manager.secretary.identity,
            )

            log.debug("Is our secretary: " + isOurSecretary)

            if (!isOurSecretary) {
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
            response.result = 200
            response.response = [manager.ourValidatorPhase.currentPhase]
            break
        }

        case "getBlockTimestamp": {
            response.result = 200
            response.response = [SecretaryManager.getInstance().blockTimestamp]
            break
        }
    }

    return response
}
