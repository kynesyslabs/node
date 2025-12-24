/**
 * IPFS Status NodeCall Handler
 *
 * Returns the health status of the IPFS node including peer ID and peer count.
 *
 * @fileoverview IPFS status endpoint
 */

import { RPCResponse } from "@kynesyslabs/demosdk/types"
import log from "@/utilities/logger"
import { getIpfsManager } from "./ipfsManager"

/**
 * Get IPFS node status
 *
 * @returns Health status including peerId, peerCount, and healthy flag
 */
export default async function ipfsStatus(): Promise<RPCResponse> {
    log.debug("[IPFS] Received ipfsStatus request")

    try {
        const ipfs = getIpfsManager()

        if (!ipfs) {
            return {
                result: 503,
                response: {
                    healthy: false,
                    error: "IPFS not initialized",
                },
                require_reply: false,
                extra: null,
            }
        }

        const health = await ipfs.healthCheck()

        return {
            result: health.healthy ? 200 : 503,
            response: {
                healthy: health.healthy,
                peerId: health.peerId,
                peerCount: health.peerCount,
                timestamp: health.timestamp,
                error: health.error,
            },
            require_reply: false,
            extra: null,
        }
    } catch (error) {
        log.error(`[IPFS] Status check failed: ${error}`)
        return {
            result: 500,
            response: {
                healthy: false,
                error: error instanceof Error ? error.message : "Unknown error",
            },
            require_reply: false,
            extra: null,
        }
    }
}
