import { RPCResponse } from "@kynesyslabs/demosdk/types"
import type { INativePayload } from "@kynesyslabs/demosdk/types"
import log from "src/utilities/logger"

/**
 * Handle a native request (e.g. a native pay on Demos Network)
 * @param content The native request
 * @returns The response
 */
export default async function handleNativeRequest(
    content: INativePayload,
): Promise<RPCResponse> {
    const operation = content.nativeOperation
    log.info(`[native] [handleNativeRequest] Received a native operation: ${operation}`)
    // TODO: Implement the logic for native operations
    return {
        result: 200,
        response: "Not implemented",
        require_reply: false,
        extra: {},
    }
}
