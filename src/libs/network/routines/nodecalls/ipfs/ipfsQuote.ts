/**
 * IPFS Quote NodeCall Handler
 *
 * Returns cost estimation for IPFS operations without creating a transaction.
 * Used in the confirm/execute two-step flow to show users costs before signing.
 *
 * @fileoverview IPFS cost quote endpoint (Phase 9)
 */

import { RPCResponse } from "@kynesyslabs/demosdk/types"
import log from "@/utilities/logger"
import {
    calculatePinCost,
    isGenesisAccount,
    PinCostResult,
} from "@/libs/blockchain/routines/ipfsTokenomics"

// ============================================================================
// Request/Response Types
// ============================================================================

/**
 * Request payload for ipfsQuote
 */
export interface IpfsQuoteRequest {
    /** Size of file in bytes */
    file_size_bytes: number
    /** IPFS operation type */
    operation: "IPFS_ADD" | "IPFS_PIN" | "IPFS_UNPIN"
    /** Optional: duration in blocks for PIN operations */
    duration_blocks?: number
}

/**
 * Response payload for ipfsQuote
 */
export interface IpfsQuoteResponse {
    /** Estimated cost in DEM (as string for BigInt safety) */
    cost_dem: string
    /** File size used for calculation */
    file_size_bytes: number
    /** Whether sender is a genesis account */
    is_genesis: boolean
    /** Detailed cost breakdown */
    breakdown: {
        /** Base cost component */
        base_cost: string
        /** Cost for file size */
        size_cost: string
        /** Bytes covered by free tier (genesis only) */
        free_tier_bytes: number
        /** Bytes that will be charged */
        chargeable_bytes: number
    }
    /** Operation quoted for */
    operation: string
}

// ============================================================================
// Handler Implementation
// ============================================================================

/**
 * Get IPFS operation cost quote
 *
 * This endpoint allows clients to get a cost estimate before building
 * and signing a transaction. The returned cost should be used as
 * max_cost_dem in the transaction's custom_charges field.
 *
 * @param data - IpfsQuoteRequest with file size and operation type
 * @param sender - Public key of the requesting account
 * @returns Cost quote with detailed breakdown
 */
export default async function ipfsQuote(
    data: IpfsQuoteRequest,
    sender: string,
): Promise<RPCResponse> {
    log.debug(`[IPFS] Received ipfsQuote request from ${sender?.slice(0, 16)}...`)

    try {
        // Validate request - REVIEW: Added NaN check since typeof NaN === "number"
        if (!data || typeof data.file_size_bytes !== "number" || Number.isNaN(data.file_size_bytes)) {
            return {
                result: 400,
                response: {
                    error: "Missing or invalid file_size_bytes",
                },
                require_reply: false,
                extra: null,
            }
        }

        if (data.file_size_bytes < 0) {
            return {
                result: 400,
                response: {
                    error: "file_size_bytes must be non-negative",
                },
                require_reply: false,
                extra: null,
            }
        }

        const validOperations = ["IPFS_ADD", "IPFS_PIN", "IPFS_UNPIN"]
        if (!data.operation || !validOperations.includes(data.operation)) {
            return {
                result: 400,
                response: {
                    error: `Invalid operation. Must be one of: ${validOperations.join(", ")}`,
                },
                require_reply: false,
                extra: null,
            }
        }

        // UNPIN operations are free
        if (data.operation === "IPFS_UNPIN") {
            const response: IpfsQuoteResponse = {
                cost_dem: "0",
                file_size_bytes: data.file_size_bytes,
                is_genesis: false, // Irrelevant for free operations
                breakdown: {
                    base_cost: "0",
                    size_cost: "0",
                    free_tier_bytes: 0,
                    chargeable_bytes: 0,
                },
                operation: data.operation,
            }

            return {
                result: 200,
                response,
                require_reply: false,
                extra: null,
            }
        }

        // Check if sender is a genesis account for preferential pricing
        const isGenesis = sender ? await isGenesisAccount(sender) : false

        // REVIEW: Phase 9 - For now, we don't track per-account free tier usage
        // Future enhancement: query account's used free bytes from GCR or storage
        const usedFreeBytes = 0

        // Calculate cost using tokenomics module
        const costResult: PinCostResult = calculatePinCost(
            data.file_size_bytes,
            isGenesis,
            usedFreeBytes,
        )

        // Build response with detailed breakdown
        const response: IpfsQuoteResponse = {
            cost_dem: costResult.totalCost.toString(),
            file_size_bytes: data.file_size_bytes,
            is_genesis: costResult.isGenesis,
            breakdown: {
                base_cost: isGenesis ? "0" : "1", // Minimum 1 DEM for regular
                size_cost: costResult.totalCost.toString(),
                free_tier_bytes: costResult.freeBytes,
                chargeable_bytes: costResult.chargeableBytes,
            },
            operation: data.operation,
        }

        log.debug(
            `[IPFS] Quote for ${data.file_size_bytes} bytes: ${costResult.totalCost} DEM (genesis: ${isGenesis})`,
        )

        return {
            result: 200,
            response,
            require_reply: false,
            extra: null,
        }
    } catch (error) {
        log.error(`[IPFS] Quote calculation failed: ${error}`)
        return {
            result: 500,
            response: {
                error: error instanceof Error ? error.message : "Unknown error",
            },
            require_reply: false,
            extra: null,
        }
    }
}
