/**
 * D402 API Routes
 * HTTP endpoints for the D402 facilitator service
 */

import { jsonResponse } from "../../bunServer"
import { D402Facilitator } from "./facilitator"
import { D402PaymentRequest } from "./types"
import { Transaction } from "@kynesyslabs/demosdk/types"
import log from "src/utilities/logger"

/**
 * GET /d402/health
 * Health check endpoint for the D402 facilitator service
 */
export async function handleD402Health(req: Request): Promise<Response> {
    try {
        const health = await D402Facilitator.healthCheck()
        return jsonResponse(health, health.status === "healthy" ? 200 : 503)
    } catch (error) {
        log.error("[D402 Routes] Health check error: " + error)
        return jsonResponse(
            {
                status: "unavailable",
                version: "1.0.0",
                timestamp: Date.now(),
                error: String(error),
            },
            503,
        )
    }
}

/**
 * GET /d402/nonce/:address
 * Get current nonce for an address
 */
export async function handleD402Nonce(req: Request): Promise<Response> {
    try {
        const url = new URL(req.url)
        const pathParts = url.pathname.split("/")
        const address = pathParts[pathParts.length - 1]

        if (!address) {
            return jsonResponse(
                {
                    error: "Address parameter is required",
                    timestamp: Date.now(),
                },
                400,
            )
        }

        const nonceData = await D402Facilitator.getNonce(address)
        return jsonResponse(nonceData, 200)
    } catch (error) {
        log.error("[D402 Routes] Nonce query error: " + error)
        return jsonResponse(
            {
                error: "Failed to retrieve nonce: " + String(error),
                timestamp: Date.now(),
            },
            500,
        )
    }
}

/**
 * POST /d402/verify
 * Verify a D402 payment transaction
 */
export async function handleD402Verify(req: Request): Promise<Response> {
    try {
        const body = (await req.json()) as D402PaymentRequest

        if (!body.transaction) {
            return jsonResponse(
                {
                    valid: false,
                    message: "Transaction is required",
                    timestamp: Date.now(),
                },
                400,
            )
        }

        const verification = await D402Facilitator.verifyPayment(
            body.transaction,
        )

        // Return 200 for valid payments, 400 for invalid
        const status = verification.valid ? 200 : 400

        return jsonResponse(verification, status)
    } catch (error) {
        log.error("[D402 Routes] Verification error: " + error)
        return jsonResponse(
            {
                valid: false,
                message: "Verification failed: " + String(error),
                timestamp: Date.now(),
            },
            500,
        )
    }
}

/**
 * POST /d402/settle
 * Settle a verified D402 payment transaction
 */
export async function handleD402Settle(req: Request): Promise<Response> {
    try {
        const body = (await req.json()) as D402PaymentRequest

        if (!body.transaction) {
            return jsonResponse(
                {
                    success: false,
                    transaction_hash: "",
                    message: "Transaction is required",
                    timestamp: Date.now(),
                },
                400,
            )
        }

        const settlement = await D402Facilitator.settlePayment(body.transaction)

        // Return 200 for successful settlement, 400 for failed
        const status = settlement.success ? 200 : 400

        return jsonResponse(settlement, status)
    } catch (error) {
        log.error("[D402 Routes] Settlement error: " + error)
        return jsonResponse(
            {
                success: false,
                transaction_hash: "",
                message: "Settlement failed: " + String(error),
                timestamp: Date.now(),
            },
            500,
        )
    }
}
