import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { INativePayload } from "node_modules/@kynesyslabs/demosdk/build/types/native"
import log from "src/utilities/logger"

/**
 * Handle a native request (e.g. a native pay on Demos Network)
 * @param content The native request
 * @returns The response
 */
export default async function handleNativeRequest(
    content: INativePayload,
): Promise<RPCResponse> {
    let operation = content.nativeOperation
    log.info("[native] [handleNativeRequest] Received a native operation: " + operation)
    // TODO: Implement the logic for native operations
    return {
        result: 200,
        response: "Not implemented",
        require_reply: false,
        extra: {},
    }
}
