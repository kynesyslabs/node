/**
 * IPFS Rate Limit Status NodeCall Handler
 *
 * Returns the current rate limit status for public bridge operations.
 * Part of Phase 5 - Public Bridge implementation.
 *
 * @fileoverview IPFS rate limit status endpoint
 *
 * REVIEW: Phase 5 - Public Bridge
 */

import { RPCResponse } from "@kynesyslabs/demosdk/types"
import log from "@/utilities/logger"
import { ensureIpfsManager } from "./ipfsManager"

/**
 * Get rate limit status for public IPFS bridge
 *
 * Returns current usage against configured limits for requests/minute
 * and bytes/minute on public gateway operations.
 *
 * @returns Rate limit status including current usage and limits
 */
export default async function ipfsRateLimitStatus(): Promise<RPCResponse> {
    log.debug("[IPFS] Received ipfsRateLimitStatus request")

    try {
        const ipfs = await ensureIpfsManager()

        // Get bridge config and rate limit status
        const config = ipfs.getPublicBridgeConfig()
        const rateLimitStatus = ipfs.getRateLimitStatus()

        return {
            result: 200,
            response: {
                success: true,
                enabled: config.enabled,
                allowPublish: config.allowPublish,
                limits: {
                    maxRequestsPerMinute: config.maxRequestsPerMinute,
                    maxBytesPerMinute: config.maxBytesPerMinute,
                },
                current: {
                    requestsThisMinute: rateLimitStatus.requestsThisMinute,
                    bytesThisMinute: rateLimitStatus.bytesThisMinute,
                    isLimited: rateLimitStatus.isLimited,
                    resetInSeconds: rateLimitStatus.resetInSeconds,
                },
                gatewayUrl: config.gatewayUrl,
            },
            require_reply: false,
            extra: null,
        }
    } catch (error) {
        log.error(`[IPFS] Rate limit status check failed: ${error}`)

        return {
            result: 500,
            response: {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            },
            require_reply: false,
            extra: null,
        }
    }
}
