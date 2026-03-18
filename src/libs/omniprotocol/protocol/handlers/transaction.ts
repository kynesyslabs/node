// REVIEW: Transaction handlers for OmniProtocol binary communication
import log from "src/utilities/logger"
import { OmniHandler } from "../../types/message"
import { decodeJsonRequest } from "../../serialization/jsonEnvelope"
import { encodeResponse, errorResponse, successResponse } from "./utils"
import type { BundleContent } from "@kynesyslabs/demosdk/types"
import type Transaction from "../../../blockchain/transaction"
import type * as bridge from "@kynesyslabs/demosdk/bridge"

interface ExecuteRequest {
    content: BundleContent
}

interface NativeBridgeRequest {
    operation: unknown // bridge.NativeBridgeOperation
}

interface BridgeRequest {
    method: string
    chain: string
    params: unknown[]
}

interface BroadcastRequest {
    content: BundleContent
}

interface ConfirmRequest {
    transaction: Transaction
}

/**
 * Handler for 0x10 EXECUTE opcode
 *
 * Handles transaction execution (both confirmTx and broadcastTx flows).
 * Wraps the existing manageExecution handler with binary encoding.
 */
export const handleExecute: OmniHandler<Buffer> = async ({
    message,
    context,
}) => {
    if (
        !message.payload ||
        !Buffer.isBuffer(message.payload) ||
        message.payload.length === 0
    ) {
        return encodeResponse(errorResponse(400, "Missing payload for execute"))
    }

    try {
        const request = decodeJsonRequest<ExecuteRequest>(message.payload)

        if (!request.content) {
            return encodeResponse(errorResponse(400, "content is required"))
        }

        const { manageExecution } =
            await import("../../../network/manageExecution")

        // Call existing HTTP handler
        const httpResponse = await manageExecution(
            request.content,
            context.peerIdentity,
        )

        if (httpResponse.result === 200) {
            return encodeResponse(successResponse(httpResponse.response))
        } else {
            return encodeResponse(
                errorResponse(
                    httpResponse.result,
                    "Execution failed",
                    httpResponse.extra,
                ),
            )
        }
    } catch (error) {
        log.error("[handleExecute] Error: " + error)
        return encodeResponse(
            errorResponse(
                500,
                "Internal error",
                error instanceof Error ? error.message : error,
            ),
        )
    }
}

/**
 * Handler for 0x11 NATIVE_BRIDGE opcode
 *
 * Handles native bridge operations for cross-chain transactions.
 * Wraps the existing manageNativeBridge handler with binary encoding.
 */
export const handleNativeBridge: OmniHandler<Buffer> = async ({
    message,
    context,
}) => {
    if (
        !message.payload ||
        !Buffer.isBuffer(message.payload) ||
        message.payload.length === 0
    ) {
        return encodeResponse(
            errorResponse(400, "Missing payload for nativeBridge"),
        )
    }

    try {
        const request = decodeJsonRequest<NativeBridgeRequest>(message.payload)

        if (!request.operation) {
            return encodeResponse(errorResponse(400, "operation is required"))
        }

        const { manageNativeBridge } =
            await import("../../../network/manageNativeBridge")

        // Call existing HTTP handler
        const httpResponse = await manageNativeBridge(
            request.operation as bridge.NativeBridgeOperation,
        )

        if (httpResponse.result === 200) {
            return encodeResponse(successResponse(httpResponse.response))
        } else {
            return encodeResponse(
                errorResponse(
                    httpResponse.result,
                    "Native bridge failed",
                    httpResponse.extra,
                ),
            )
        }
    } catch (error) {
        log.error("[handleNativeBridge] Error: " + error)
        return encodeResponse(
            errorResponse(
                500,
                "Internal error",
                error instanceof Error ? error.message : error,
            ),
        )
    }
}

/**
 * Handler for 0x12 BRIDGE opcode
 *
 * Handles bridge operations (get_trade, execute_trade via Rubic).
 * Wraps the existing manageBridges handler with binary encoding.
 */
export const handleBridge: OmniHandler<Buffer> = async ({
    message,
    context,
}) => {
    if (
        !message.payload ||
        !Buffer.isBuffer(message.payload) ||
        message.payload.length === 0
    ) {
        return encodeResponse(errorResponse(400, "Missing payload for bridge"))
    }

    try {
        const request = decodeJsonRequest<BridgeRequest>(message.payload)

        if (!request.method) {
            return encodeResponse(errorResponse(400, "method is required"))
        }

        if (!request.chain) {
            return encodeResponse(errorResponse(400, "chain is required"))
        }

        const { default: manageBridges } =
            await import("../../../network/manageBridge")

        const bridgePayload = {
            method: request.method,
            chain: request.chain,
            params: request.params || [],
        }

        // Call existing HTTP handler
        const httpResponse = await manageBridges(
            context.peerIdentity,
            bridgePayload,
        )

        if (httpResponse.result === 200) {
            return encodeResponse(successResponse(httpResponse.response))
        } else {
            return encodeResponse(
                errorResponse(
                    httpResponse.result,
                    "Bridge operation failed",
                    httpResponse.extra,
                ),
            )
        }
    } catch (error) {
        log.error("[handleBridge] Error: " + error)
        return encodeResponse(
            errorResponse(
                500,
                "Internal error",
                error instanceof Error ? error.message : error,
            ),
        )
    }
}

/**
 * Handler for 0x16 BROADCAST opcode
 *
 * Handles transaction broadcast to the network mempool.
 * This is specifically for the broadcastTx flow after validation.
 * Wraps the existing manageExecution handler with binary encoding.
 */
export const handleBroadcast: OmniHandler<Buffer> = async ({
    message,
    context,
}) => {
    if (
        !message.payload ||
        !Buffer.isBuffer(message.payload) ||
        message.payload.length === 0
    ) {
        return encodeResponse(
            errorResponse(400, "Missing payload for broadcast"),
        )
    }

    try {
        const request = decodeJsonRequest<BroadcastRequest>(message.payload)

        if (!request.content) {
            return encodeResponse(errorResponse(400, "content is required"))
        }

        // Ensure the content has the broadcastTx extra field
        const broadcastContent = {
            ...request.content,
            extra: "broadcastTx",
        }

        const { manageExecution } =
            await import("../../../network/manageExecution")

        // Call existing HTTP handler with broadcastTx mode
        const httpResponse = await manageExecution(
            broadcastContent,
            context.peerIdentity,
        )

        if (httpResponse.result === 200) {
            return encodeResponse(successResponse(httpResponse.response))
        } else {
            return encodeResponse(
                errorResponse(
                    httpResponse.result,
                    "Broadcast failed",
                    httpResponse.extra,
                ),
            )
        }
    } catch (error) {
        log.error("[handleBroadcast] Error: " + error)
        return encodeResponse(
            errorResponse(
                500,
                "Internal error",
                error instanceof Error ? error.message : error,
            ),
        )
    }
}

/**
 * Handler for 0x15 CONFIRM opcode
 *
 * Dedicated transaction validation endpoint (simpler than execute).
 * Takes a Transaction directly and returns ValidityData with gas calculation.
 * This is the clean validation-only endpoint for basic transaction flows.
 */
export const handleConfirm: OmniHandler<Buffer> = async ({
    message,
    context,
}) => {
    if (
        !message.payload ||
        !Buffer.isBuffer(message.payload) ||
        message.payload.length === 0
    ) {
        return encodeResponse(errorResponse(400, "Missing payload for confirm"))
    }

    try {
        const request = decodeJsonRequest<ConfirmRequest>(message.payload)

        if (!request.transaction) {
            return encodeResponse(errorResponse(400, "transaction is required"))
        }

        const { default: serverHandlers } =
            await import("../../../network/endpointHandlers")

        // Call validation handler directly (confirmTx flow)
        const validityData = await serverHandlers.handleValidateTransaction(
            request.transaction,
            context.peerIdentity,
        )

        // ValidityData is always returned (with valid=false if validation fails)
        return encodeResponse(successResponse(validityData))
    } catch (error) {
        log.error("[handleConfirm] Error: " + error)
        return encodeResponse(
            errorResponse(
                500,
                "Internal error",
                error instanceof Error ? error.message : error,
            ),
        )
    }
}
