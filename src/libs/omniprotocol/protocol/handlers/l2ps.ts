/**
 * L2PS (Layer 2 Private System) handlers for OmniProtocol binary communication
 *
 * Provides handlers for:
 * - 0x70 L2PS_GENERIC: Generic L2PS operation fallback
 * - 0x71 L2PS_SUBMIT_ENCRYPTED_TX: Submit encrypted L2PS transaction
 * - 0x72 L2PS_GET_PROOF: Get ZK proof for a batch
 * - 0x73 L2PS_VERIFY_BATCH: Verify batch integrity
 * - 0x74 L2PS_SYNC_MEMPOOL: Sync L2PS mempool entries
 * - 0x75 L2PS_GET_BATCH_STATUS: Get batch aggregation status
 * - 0x76 L2PS_GET_PARTICIPATION: Check L2PS network participation
 * - 0x77 L2PS_HASH_UPDATE: Relay hash update to validators
 */

import log from "src/utilities/logger"
import { OmniHandler } from "../../types/message"
import { decodeJsonRequest } from "../../serialization/jsonEnvelope"
import { encodeResponse, errorResponse, successResponse } from "./utils"
import type {
    L2PSSubmitEncryptedTxRequest,
    L2PSGetProofRequest,
    L2PSVerifyBatchRequest,
    L2PSSyncMempoolRequest,
    L2PSGetBatchStatusRequest,
    L2PSGetParticipationRequest,
    L2PSHashUpdateRequest,
} from "../../serialization/l2ps"
import { decodeL2PSHashUpdate } from "../../serialization/l2ps"

/**
 * Handler for 0x70 L2PS_GENERIC opcode
 *
 * Fallback handler for generic L2PS operations.
 * Routes to appropriate L2PS subsystem based on request.
 */
export const handleL2PSGeneric: OmniHandler<Buffer> = async ({ message, context }) => {
    if (!message.payload || !Buffer.isBuffer(message.payload) || message.payload.length === 0) {
        return encodeResponse(errorResponse(400, "Missing payload for L2PS generic"))
    }

    try {
        const request = decodeJsonRequest<{ operation: string; params: unknown }>(message.payload)

        if (!request.operation) {
            return encodeResponse(errorResponse(400, "operation is required"))
        }

        // Route to manageNodeCall for L2PS operations
        const { manageNodeCall } = await import("../../../network/manageNodeCall")

        const nodeCallPayload = {
            message: request.operation,
            data: request.params,
            muid: null,
        }

        const httpResponse = await manageNodeCall(nodeCallPayload)

        if (httpResponse.result === 200) {
            return encodeResponse(successResponse(httpResponse.response))
        } else {
            return encodeResponse(
                errorResponse(httpResponse.result, "L2PS operation failed", httpResponse.extra),
            )
        }
    } catch (error) {
        log.error("[handleL2PSGeneric] Error:", error)
        return encodeResponse(
            errorResponse(500, "Internal error", error instanceof Error ? error.message : error),
        )
    }
}

/**
 * Handler for 0x71 L2PS_SUBMIT_ENCRYPTED_TX opcode
 *
 * Submits an encrypted L2PS transaction for processing.
 * The transaction is decrypted, validated, and added to L2PS mempool.
 */
export const handleL2PSSubmitEncryptedTx: OmniHandler<Buffer> = async ({ message, context }) => {
    if (!message.payload || !Buffer.isBuffer(message.payload) || message.payload.length === 0) {
        return encodeResponse(errorResponse(400, "Missing payload for L2PS submit"))
    }

    try {
        const request = decodeJsonRequest<L2PSSubmitEncryptedTxRequest>(message.payload)

        if (!request.l2psUid) {
            return encodeResponse(errorResponse(400, "l2psUid is required"))
        }

        if (!request.encryptedTx) {
            return encodeResponse(errorResponse(400, "encryptedTx is required"))
        }

        // Parse the encrypted transaction from JSON string
        let l2psTx
        try {
            l2psTx = JSON.parse(request.encryptedTx)
        } catch {
            return encodeResponse(errorResponse(400, "Invalid encryptedTx format"))
        }

        // Call existing handleL2PS handler
        const handleL2PS = (await import(
            "../../../network/routines/transactions/handleL2PS"
        )).default

        const httpResponse = await handleL2PS(l2psTx)

        if (httpResponse.result === 200) {
            return encodeResponse(successResponse(httpResponse.response))
        } else {
            return encodeResponse(
                errorResponse(
                    httpResponse.result,
                    "L2PS transaction failed",
                    httpResponse.extra,
                ),
            )
        }
    } catch (error) {
        log.error("[handleL2PSSubmitEncryptedTx] Error:", error)
        return encodeResponse(
            errorResponse(500, "Internal error", error instanceof Error ? error.message : error),
        )
    }
}

/**
 * Handler for 0x72 L2PS_GET_PROOF opcode
 *
 * Retrieves a ZK proof for a specific batch.
 * Returns proof data if available, or 404 if not found.
 */
export const handleL2PSGetProof: OmniHandler<Buffer> = async ({ message, context }) => {
    if (!message.payload || !Buffer.isBuffer(message.payload) || message.payload.length === 0) {
        return encodeResponse(errorResponse(400, "Missing payload for L2PS get proof"))
    }

    try {
        const request = decodeJsonRequest<L2PSGetProofRequest>(message.payload)

        if (!request.batchHash) {
            return encodeResponse(errorResponse(400, "batchHash is required"))
        }

        const L2PSProofManager = (await import("../../../l2ps/L2PSProofManager")).default

        const proof = await L2PSProofManager.getProofByBatchHash(request.batchHash)

        if (!proof) {
            return encodeResponse(errorResponse(404, "Proof not found"))
        }

        return encodeResponse(
            successResponse({
                proofHash: proof.transactions_hash,
                batchHash: proof.l1_batch_hash,
                transactionCount: proof.transaction_count,
                status: proof.status,
                createdAt: proof.created_at,
            }),
        )
    } catch (error) {
        log.error("[handleL2PSGetProof] Error:", error)
        return encodeResponse(
            errorResponse(500, "Internal error", error instanceof Error ? error.message : error),
        )
    }
}

/**
 * Handler for 0x73 L2PS_VERIFY_BATCH opcode
 *
 * Verifies the integrity of an L2PS batch.
 * Checks proof validity and batch hash.
 */
export const handleL2PSVerifyBatch: OmniHandler<Buffer> = async ({ message, context }) => {
    if (!message.payload || !Buffer.isBuffer(message.payload) || message.payload.length === 0) {
        return encodeResponse(errorResponse(400, "Missing payload for L2PS verify batch"))
    }

    try {
        const request = decodeJsonRequest<L2PSVerifyBatchRequest>(message.payload)

        if (!request.batchHash) {
            return encodeResponse(errorResponse(400, "batchHash is required"))
        }

        const L2PSProofManager = (await import("../../../l2ps/L2PSProofManager")).default

        const proof = await L2PSProofManager.getProofByBatchHash(request.batchHash)

        if (!proof) {
            return encodeResponse(
                successResponse({
                    valid: false,
                    reason: "Proof not found for batch",
                }),
            )
        }

        // Verify proof hash matches if provided
        if (request.proofHash && proof.transactions_hash !== request.proofHash) {
            return encodeResponse(
                successResponse({
                    valid: false,
                    reason: "Proof hash mismatch",
                }),
            )
        }

        // "applied" is the success state for L2PSProofStatus
        return encodeResponse(
            successResponse({
                valid: proof.status === "applied",
                status: proof.status,
                transactionCount: proof.transaction_count,
            }),
        )
    } catch (error) {
        log.error("[handleL2PSVerifyBatch] Error:", error)
        return encodeResponse(
            errorResponse(500, "Internal error", error instanceof Error ? error.message : error),
        )
    }
}

/**
 * Handler for 0x74 L2PS_SYNC_MEMPOOL opcode
 *
 * Synchronizes L2PS mempool entries between nodes.
 * Returns entries since the given timestamp.
 */
export const handleL2PSSyncMempool: OmniHandler<Buffer> = async ({ message, context }) => {
    if (!message.payload || !Buffer.isBuffer(message.payload) || message.payload.length === 0) {
        return encodeResponse(errorResponse(400, "Missing payload for L2PS sync mempool"))
    }

    try {
        const request = decodeJsonRequest<L2PSSyncMempoolRequest>(message.payload)

        if (!request.l2psUid) {
            return encodeResponse(errorResponse(400, "l2psUid is required"))
        }

        const L2PSMempool = (await import("../../../blockchain/l2ps_mempool")).default

        const entries = await L2PSMempool.getByUID(request.l2psUid)

        // Filter by timestamp if provided
        const filteredEntries = request.fromTimestamp
            ? entries.filter((e) => Number(e.timestamp) > request.fromTimestamp!)
            : entries

        // Apply limit
        const limitedEntries = request.limit
            ? filteredEntries.slice(0, request.limit)
            : filteredEntries

        return encodeResponse(
            successResponse({
                entries: limitedEntries.map((e) => ({
                    hash: e.hash,
                    l2psUid: e.l2ps_uid,
                    originalHash: e.original_hash,
                    status: e.status,
                    timestamp: Number(e.timestamp),
                })),
                count: limitedEntries.length,
            }),
        )
    } catch (error) {
        log.error("[handleL2PSSyncMempool] Error:", error)
        return encodeResponse(
            errorResponse(500, "Internal error", error instanceof Error ? error.message : error),
        )
    }
}

/**
 * Handler for 0x75 L2PS_GET_BATCH_STATUS opcode
 *
 * Gets the current batch aggregation status for an L2PS network.
 * Returns pending transactions and aggregation state.
 */
export const handleL2PSGetBatchStatus: OmniHandler<Buffer> = async ({ message, context }) => {
    if (!message.payload || !Buffer.isBuffer(message.payload) || message.payload.length === 0) {
        return encodeResponse(errorResponse(400, "Missing payload for L2PS batch status"))
    }

    try {
        const request = decodeJsonRequest<L2PSGetBatchStatusRequest>(message.payload)

        if (!request.l2psUid) {
            return encodeResponse(errorResponse(400, "l2psUid is required"))
        }

        // Get pending transactions from L2PS mempool
        const L2PSMempool = (await import("../../../blockchain/l2ps_mempool")).default

        const pendingTxs = await L2PSMempool.getByUID(request.l2psUid, "processed")

        return encodeResponse(
            successResponse({
                found: true,
                pendingTransactions: pendingTxs.length,
                l2psUid: request.l2psUid,
            }),
        )
    } catch (error) {
        log.error("[handleL2PSGetBatchStatus] Error:", error)
        return encodeResponse(
            errorResponse(500, "Internal error", error instanceof Error ? error.message : error),
        )
    }
}

/**
 * Handler for 0x76 L2PS_GET_PARTICIPATION opcode
 *
 * Checks if an address or this node participates in an L2PS network.
 * Used for network discovery and membership validation.
 */
export const handleL2PSGetParticipation: OmniHandler<Buffer> = async ({ message, context }) => {
    if (!message.payload || !Buffer.isBuffer(message.payload) || message.payload.length === 0) {
        return encodeResponse(errorResponse(400, "Missing payload for L2PS participation"))
    }

    try {
        const request = decodeJsonRequest<L2PSGetParticipationRequest>(message.payload)

        if (!request.l2psUid) {
            return encodeResponse(errorResponse(400, "l2psUid is required"))
        }

        const ParallelNetworks = (await import("../../../l2ps/parallelNetworks")).default

        const parallelNetworks = ParallelNetworks.getInstance()
        const l2psInstance = await parallelNetworks.getL2PS(request.l2psUid)

        if (!l2psInstance) {
            return encodeResponse(
                successResponse({
                    participating: false,
                    reason: "L2PS network not loaded",
                }),
            )
        }

        return encodeResponse(
            successResponse({
                participating: true,
                l2psUid: request.l2psUid,
                encryptionEnabled: true,
            }),
        )
    } catch (error) {
        log.error("[handleL2PSGetParticipation] Error:", error)
        return encodeResponse(
            errorResponse(500, "Internal error", error instanceof Error ? error.message : error),
        )
    }
}

/**
 * Handler for 0x77 L2PS_HASH_UPDATE opcode
 *
 * Receives hash updates from other nodes.
 * Used for synchronizing L2PS state hashes across the network.
 * Uses binary encoding for efficiency.
 */
export const handleL2PSHashUpdate: OmniHandler<Buffer> = async ({ message, context }) => {
    if (!message.payload || !Buffer.isBuffer(message.payload) || message.payload.length === 0) {
        return encodeResponse(errorResponse(400, "Missing payload for L2PS hash update"))
    }

    try {
        // Try binary decoding first, fall back to JSON
        let request: L2PSHashUpdateRequest
        try {
            request = decodeL2PSHashUpdate(message.payload)
        } catch {
            // Fallback to JSON encoding
            request = decodeJsonRequest<L2PSHashUpdateRequest>(message.payload)
        }

        if (!request.l2psUid) {
            return encodeResponse(errorResponse(400, "l2psUid is required"))
        }

        if (!request.consolidatedHash) {
            return encodeResponse(errorResponse(400, "consolidatedHash is required"))
        }

        const L2PSHashes = (await import("../../../blockchain/l2ps_hashes")).default

        // Store the hash update
        await L2PSHashes.updateHash(
            request.l2psUid,
            request.consolidatedHash,
            request.transactionCount,
            BigInt(request.blockNumber),
        )

        return encodeResponse(
            successResponse({
                accepted: true,
                l2psUid: request.l2psUid,
                hash: request.consolidatedHash,
            }),
        )
    } catch (error) {
        log.error("[handleL2PSHashUpdate] Error:", error)
        return encodeResponse(
            errorResponse(500, "Internal error", error instanceof Error ? error.message : error),
        )
    }
}
