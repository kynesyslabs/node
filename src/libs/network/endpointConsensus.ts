import Mempool from "src/libs/blockchain/mempool_v2"
import { ConsensusRequest, RPCResponse } from "@kynesyslabs/demosdk/types"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"
import { emptyResponse } from "./rpcDispatch"

export async function handleConsensusRequest(
    request: ConsensusRequest,
): Promise<RPCResponse> {
    const response: RPCResponse = structuredClone(emptyResponse)
    const senderIdentity = request.sender

    if (!getSharedState.consensusMode) {
        log.error("[endpointHandlers] We are not in consensus mode")
        response.result = 400
        response.response = false
        response.extra =
            "We are not in consensus mode (and you are using the old consensus mechanism)"
        return response
    }

    let authorized = false
    const senderPublicKey = senderIdentity

    const { shard } = getSharedState

    if (!shard) {
        log.error("[endpointHandlers] No shard found in shared state")
        response.result = 400
        response.response = false
        response.extra = "No shard found in shared state"
        return response
    }

    const peerList = shard

    for (const peer of peerList) {
        if (peer.identity === senderPublicKey) {
            authorized = true
            break
        }
    }

    if (!authorized) {
        log.error("[endpointHandlers] Not authorized")
        response.result = 401
        response.response = false
        response.extra = "Not authorized"
        return response
    }

    switch (request.message) {
        case "getMempool":
            response.response = await Mempool.getMempool()
            response.result = 200
            response.require_reply = false
            response.extra = "Mempool received"
            return response

        default:
            log.error("[endpointHandlers] Unknown message")
            response.result = 400
            response.response = false
            response.extra = "Unknown message"
            return response
    }
}
