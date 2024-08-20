import { manageVote } from "./manageVote"
import { RPCResponse, VoteRequest } from "@kynesyslabs/demosdk-http/types"
import getCommonValidatorSeed from "../consensus/v2/routines/getCommonValidatorSeed"
import { emptyResponse } from "./server_rpc"
import _ from "lodash"
import ServerHandlers from "./endpointHandlers"
import sharedState from "src/utilities/sharedState"

export interface ConsensusMethod {
    method: "vote" | "voteRequest" | "broadcastBlock" | "getCommonValidatorSeed"
    params: any[]
}

export default async function manageConsensusRoutines(payload: ConsensusMethod): Promise<RPCResponse> {
    let response = _.cloneDeep(emptyResponse)
    // Each method has its own logic to be implemented
    switch (payload.method) {
        case "vote":
            return await manageVote(
                payload.params[0] as VoteRequest,
                payload.params[1] as (response: RPCResponse) => void,
            )
        case "voteRequest":
            return await ServerHandlers.handleVoteRequest(payload.params[0].timestamp)
        case "broadcastBlock":
            break
        case "getCommonValidatorSeed":
            response.result = 200
            await getCommonValidatorSeed() // ? Should we generate it each time? I think so
            response.response = sharedState.getInstance().currentValidatorSeed
            break
    }

    return emptyResponse
}