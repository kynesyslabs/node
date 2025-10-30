/**
 * D402 Facilitator
 * Core logic for D402 payment verification and settlement
 */

import { Transaction } from "@kynesyslabs/demosdk/types"
import GCR from "src/libs/blockchain/gcr/gcr"
import TransactionClass from "src/libs/blockchain/transaction"
import {
    D402ErrorCode,
    D402VerificationResponse,
    D402SettlementResponse,
    D402NonceResponse,
    D402HealthResponse,
} from "./types"
import { getSharedState } from "src/utilities/sharedState"
import terminalkit from "terminal-kit"

const term = terminalkit.terminal

/**
 * D402Facilitator
 * Handles payment verification, nonce management, and settlement for D402 protocol
 */
export class D402Facilitator {
    /**
     * Verify a D402 payment transaction
     * Checks signature, nonce, timestamp, balance, and amount validity
     */
    static async verifyPayment(
        tx: Transaction,
    ): Promise<D402VerificationResponse> {
        term.yellow("[D402 Facilitator] Verifying payment...\n")

        try {
            // 1. Validate transaction structure
            if (!tx.content || tx.content.type !== "d402_payment") {
                return {
                    valid: false,
                    message: "Invalid transaction type",
                    error_code: D402ErrorCode.MALFORMED_TRANSACTION,
                    timestamp: Date.now(),
                }
            }

            // 2. Extract D402 payload
            const d402Data = tx.content.data as ["d402_payment", any]
            const payload = d402Data[1]

            if (!payload || !payload.to || !payload.amount) {
                return {
                    valid: false,
                    message: "Missing required D402 payment fields",
                    error_code: D402ErrorCode.MALFORMED_TRANSACTION,
                    timestamp: Date.now(),
                }
            }

            const { to, amount } = payload
            const from = tx.content.from_ed25519_address

            // 3. Validate addresses
            if (!from || !to) {
                return {
                    valid: false,
                    message: "Invalid sender or recipient address",
                    error_code: D402ErrorCode.INVALID_ADDRESS,
                    timestamp: Date.now(),
                }
            }

            // 4. Validate amount
            if (typeof amount !== "number" || amount <= 0) {
                return {
                    valid: false,
                    message: "Invalid payment amount",
                    error_code: D402ErrorCode.INVALID_AMOUNT,
                    timestamp: Date.now(),
                }
            }

            // 5. Verify signature
            const { confirmation, message, success: verified } =
                await TransactionClass.confirmTx(tx, from)

            if (!verified) {
                return {
                    valid: false,
                    message: `Signature verification failed: ${message}`,
                    error_code: D402ErrorCode.INVALID_SIGNATURE,
                    timestamp: Date.now(),
                }
            }

            // 6. Check nonce
            const currentNonce = await GCR.getGCRNonce(from)
            if (tx.content.nonce !== currentNonce) {
                return {
                    valid: false,
                    message: `Invalid nonce. Expected: ${currentNonce}, got: ${tx.content.nonce}`,
                    error_code: D402ErrorCode.INVALID_NONCE,
                    timestamp: Date.now(),
                }
            }

            // 7. Check timestamp (allow 5 minutes in the past, 1 minute in the future)
            const now = Date.now()
            const txTimestamp = tx.content.timestamp
            const maxPastDrift = 5 * 60 * 1000 // 5 minutes
            const maxFutureDrift = 1 * 60 * 1000 // 1 minute

            if (txTimestamp < now - maxPastDrift) {
                return {
                    valid: false,
                    message: "Transaction timestamp too old",
                    error_code: D402ErrorCode.TIMESTAMP_TOO_OLD,
                    timestamp: Date.now(),
                }
            }

            if (txTimestamp > now + maxFutureDrift) {
                return {
                    valid: false,
                    message: "Transaction timestamp in the future",
                    error_code: D402ErrorCode.TIMESTAMP_IN_FUTURE,
                    timestamp: Date.now(),
                }
            }

            // 8. Check balance (D402 is gasless, so only check payment amount)
            const balance = await GCR.getGCRNativeBalance(from)
            if (balance < amount) {
                return {
                    valid: false,
                    message: `Insufficient balance. Required: ${amount}, available: ${balance}`,
                    error_code: D402ErrorCode.INSUFFICIENT_BALANCE,
                    timestamp: Date.now(),
                }
            }

            // All checks passed
            term.green("[D402 Facilitator] Payment verified successfully\n")
            return {
                valid: true,
                message: "Payment verified successfully",
                timestamp: Date.now(),
                verified_amount: amount,
                verified_from: from,
                verified_to: to,
            }
        } catch (error) {
            term.red.bold(
                "[D402 Facilitator] Verification error: " + error + "\n",
            )
            return {
                valid: false,
                message: "Internal verification error: " + error,
                error_code: D402ErrorCode.INTERNAL_ERROR,
                timestamp: Date.now(),
            }
        }
    }

    /**
     * Settle a verified D402 payment
     * Broadcasts the transaction to the network for consensus
     */
    static async settlePayment(
        tx: Transaction,
    ): Promise<D402SettlementResponse> {
        term.yellow("[D402 Facilitator] Settling payment...\n")

        const startTime = Date.now()

        try {
            // 1. Verify the payment first
            const verification = await this.verifyPayment(tx)
            if (!verification.valid) {
                return {
                    success: false,
                    transaction_hash: tx.hash || "",
                    message: `Settlement failed: ${verification.message}`,
                    error_code: verification.error_code,
                    timestamp: Date.now(),
                }
            }

            // 2. Import the settlement function
            const { broadcastVerifiedNativeTransaction } = await import(
                "src/libs/blockchain/routines/validateTransaction"
            )

            // 3. Create validity data for settlement
            const validityData = {
                data: {
                    valid: true,
                    reference_block: 0, // Will be set by consensus
                    message: "D402 payment verified",
                    gas_operation: null, // D402 is gasless
                    transaction: tx,
                },
                signature: null, // Will be set by RPC
                rpc_public_key: null, // Will be set by RPC
            }

            // 4. Execute settlement
            const [success, message, operations] =
                await broadcastVerifiedNativeTransaction(validityData)

            if (!success) {
                return {
                    success: false,
                    transaction_hash: tx.hash,
                    message: `Settlement execution failed: ${message}`,
                    error_code: D402ErrorCode.SETTLEMENT_FAILED,
                    timestamp: Date.now(),
                }
            }

            const settlementTime = Date.now() - startTime

            term.green(
                `[D402 Facilitator] Payment settled successfully in ${settlementTime}ms\n`,
            )

            return {
                success: true,
                transaction_hash: tx.hash,
                message: "Payment settled successfully",
                timestamp: Date.now(),
                block_number: tx.blockNumber || undefined,
                settlement_time_ms: settlementTime,
            }
        } catch (error) {
            term.red.bold(
                "[D402 Facilitator] Settlement error: " + error + "\n",
            )
            return {
                success: false,
                transaction_hash: tx.hash || "",
                message: "Internal settlement error: " + error,
                error_code: D402ErrorCode.INTERNAL_ERROR,
                timestamp: Date.now(),
            }
        }
    }

    /**
     * Get current nonce for an address
     */
    static async getNonce(address: string): Promise<D402NonceResponse> {
        try {
            const nonce = await GCR.getGCRNonce(address)
            return {
                address,
                nonce,
                timestamp: Date.now(),
            }
        } catch (error) {
            // If address doesn't exist, nonce is 0
            return {
                address,
                nonce: 0,
                timestamp: Date.now(),
            }
        }
    }

    /**
     * Health check for the facilitator service
     */
    static async healthCheck(): Promise<D402HealthResponse> {
        try {
            // Check if GCR is accessible
            const gcrConnected = GCR.getInstance() !== null

            return {
                status: gcrConnected ? "healthy" : "degraded",
                version: "1.0.0",
                timestamp: Date.now(),
                rpc_connected: true,
                consensus_active: getSharedState.PROD || false,
            }
        } catch (error) {
            return {
                status: "unavailable",
                version: "1.0.0",
                timestamp: Date.now(),
                rpc_connected: false,
                consensus_active: false,
            }
        }
    }
}
