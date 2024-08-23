import { manageVote } from "./manageVote"
import { RPCResponse, VoteRequest } from "@kynesyslabs/demosdk-http/types"
import getCommonValidatorSeed from "../consensus/v2/routines/getCommonValidatorSeed"
import { emptyResponse } from "./server_rpc"
import _ from "lodash"
import ServerHandlers from "./endpointHandlers"
import sharedState from "src/utilities/sharedState"
import { ProofOfRepresentation } from "../consensus/mechanisms/PoR"
import getShard from "../consensus/v2/routines/getShard"
import { Peer } from "../peer"
import manageProposeBlockHash from "../consensus/v2/routines/manageProposeBlockHash"
import { ValidationData } from "../consensus/v2/interfaces"

export interface ConsensusMethod {
    method:
        | "vote"
        | "voteRequest"
        | "proposeBlockHash"
        | "broadcastBlock"
        | "getCommonValidatorSeed"
        | "getValidatorTimestamp"
    params: any[]
}

export default async function manageConsensusRoutines(
    payload: ConsensusMethod,
): Promise<RPCResponse> {
    let response = _.cloneDeep(emptyResponse)
    // Refuses the routine if we are not in consensus mode
    if (!sharedState.getInstance().consensusMode) {
        response.result = 400
        response.response = "Consensus mode is not active"
        return response
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
        // ANCHOR New methods for consensus v2
        case "getValidatorTimestamp":
            response.result = 200
            response.response = sharedState.getInstance().lastTimestamp
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
    }

    return response
}
