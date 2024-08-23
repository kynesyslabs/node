import { manageVote } from "./manageVote"
import { RPCResponse, VoteRequest } from "@kynesyslabs/demosdk-http/types"
import getCommonValidatorSeed from "../consensus/v2/routines/getCommonValidatorSeed"
import { emptyResponse } from "./server_rpc"
import _ from "lodash"
import ServerHandlers from "./endpointHandlers"
import sharedState from "src/utilities/sharedState"

export interface ConsensusMethod {
    method: "vote" | "voteRequest" | "proposeBlockHash" | "broadcastBlock" | "getCommonValidatorSeed"
    params: any[]
}

export default async function manageConsensusRoutines(payload: ConsensusMethod): Promise<RPCResponse> {
    let response = _.cloneDeep(emptyResponse)
    // Each method has its own logic to be implemented
    switch (payload.method) {
        // ANCHOR Old methods for consensus v1
        case "vote":
            return await manageVote(
                payload.params[0] as VoteRequest,
                payload.params[1] as (response: RPCResponse) => void,
            )
        case "voteRequest":
            return await ServerHandlers.handleVoteRequest(payload.params[0].timestamp)
        // ANCHOR New methods for consensus v2
        case "proposeBlockHash": // For shard members to vote on a block hash
            // TODO: Check if we are in the shard -> if we are, compare the block hash with the one we have and reply [true, validation_data]
            break
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