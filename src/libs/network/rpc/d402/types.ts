/**
 * D402 Protocol Types
 * Types and interfaces for the D402 HTTP Payment Protocol implementation
 */

import { Transaction } from "@kynesyslabs/demosdk/types"

/**
 * D402 Error Codes
 * Categorized error codes for different failure scenarios
 */
export enum D402ErrorCode {
    // Verification Errors (1000-1999)
    INVALID_SIGNATURE = 1000,
    INVALID_NONCE = 1001,
    TIMESTAMP_TOO_OLD = 1002,
    TIMESTAMP_IN_FUTURE = 1003,
    INSUFFICIENT_BALANCE = 1004,
    INVALID_AMOUNT = 1005,
    INVALID_ADDRESS = 1006,
    MALFORMED_TRANSACTION = 1007,

    // Settlement Errors (2000-2999)
    SETTLEMENT_FAILED = 2000,
    CONSENSUS_TIMEOUT = 2001,
    DOUBLE_SPEND_DETECTED = 2002,
    BALANCE_LOCKED = 2003,

    // System Errors (3000-3999)
    FACILITATOR_UNAVAILABLE = 3000,
    RPC_ERROR = 3001,
    DATABASE_ERROR = 3002,
    INTERNAL_ERROR = 3999,

    // Rate Limiting (4000-4999)
    RATE_LIMIT_EXCEEDED = 4000,
    TOO_MANY_REQUESTS = 4001,
}

/**
 * D402 Verification Response
 * Result of payment verification
 */
export interface D402VerificationResponse {
    valid: boolean
    message: string
    error_code?: D402ErrorCode
    timestamp: number
    verified_amount?: number
    verified_from?: string
    verified_to?: string
}

/**
 * D402 Settlement Response
 * Result of payment settlement
 */
export interface D402SettlementResponse {
    success: boolean
    transaction_hash: string
    message: string
    error_code?: D402ErrorCode
    timestamp: number
    block_number?: number
    settlement_time_ms?: number
}

/**
 * D402 Nonce Response
 * Current nonce for an address
 */
export interface D402NonceResponse {
    address: string
    nonce: number
    timestamp: number
}

/**
 * D402 Health Check Response
 * Status of the facilitator service
 */
export interface D402HealthResponse {
    status: "healthy" | "degraded" | "unavailable"
    version: string
    timestamp: number
    rpc_connected: boolean
    consensus_active: boolean
}

/**
 * D402 Payment Request
 * Client request for payment verification and settlement
 */
export interface D402PaymentRequest {
    transaction: Transaction
}
