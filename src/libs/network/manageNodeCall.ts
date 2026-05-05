import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { emptyResponse } from "./server_rpc"
import { handlerRegistry } from "./handlers"
import log from "src/utilities/logger"

export interface NodeCall {
    message: string
    data: any
    muid: string
}

/**
 * Dispatches an incoming NodeCall message to the appropriate handler and produces an RPCResponse.
 *
 * @param content - NodeCall containing `message` (the RPC action to perform), `data` (payload for the action), and `muid` (message unique id)
 * @returns An RPCResponse containing the numeric status, the response payload for the requested action, and optional `extra` diagnostic data
 */
export async function manageNodeCall(content: NodeCall): Promise<RPCResponse> {
    const { data } = content
    const response = structuredClone(emptyResponse)
    response.result = 200
    response.require_reply = false
    response.extra = null
    log.debug("[manageNodeCall] Content: " + JSON.stringify(content))

    const handler = handlerRegistry[content.message]
    if (handler) {
        return await handler(data, response)
    }

    // Return a real 404 with a structured error body so SDK clients can
    // detect unsupported methods. The previous implementation returned 200
    // with a Python-dict-shaped string, which the SDK couldn't distinguish
    // from a successful response.
    log.warning(`[SERVER] Received unknown message: ${content?.message}`)
    response.result = 404
    response.response = {
        error: "Unknown message",
        message: content?.message,
    }
    return response
}
