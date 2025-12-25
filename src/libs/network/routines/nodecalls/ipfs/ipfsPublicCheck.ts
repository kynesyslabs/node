/**
 * IPFS Public Check NodeCall Handler
 *
 * Checks if content is available on public IPFS gateways.
 * Part of Phase 5 - Public Bridge implementation.
 *
 * @fileoverview IPFS public availability check endpoint
 *
 * REVIEW: Phase 5 - Public Bridge
 */

import { RPCResponse } from "@kynesyslabs/demosdk/types"
import log from "@/utilities/logger"
import { ensureIpfsManager } from "./ipfsManager"

interface IpfsPublicCheckData {
    /** Content Identifier to check on public network */
    cid: string
}

/**
 * Check if content is available on public IPFS gateways
 *
 * This endpoint performs a lightweight HEAD request to check if content
 * exists on public gateways without downloading the full content.
 *
 * @param data - CID of content to check
 * @returns Availability status and gateway info
 */
export default async function ipfsPublicCheck(data: IpfsPublicCheckData): Promise<RPCResponse> {
    log.debug(`[IPFS] Received ipfsPublicCheck request for CID: ${data?.cid}`)

    if (!data?.cid) {
        return {
            result: 400,
            response: {
                success: false,
                error: "No CID provided",
            },
            require_reply: false,
            extra: null,
        }
    }

    try {
        const ipfs = await ensureIpfsManager()

        // Check if public bridge is enabled
        if (!ipfs.isPublicBridgeEnabled()) {
            return {
                result: 403,
                response: {
                    success: false,
                    error: "Public bridge is disabled. Set DEMOS_IPFS_PUBLIC_BRIDGE_ENABLED=true to enable.",
                },
                require_reply: false,
                extra: null,
            }
        }

        const checkResult = await ipfs.isPubliclyAvailable(data.cid)

        log.debug(`[IPFS] Public availability check for ${data.cid}: ${checkResult.available ? "available" : "not found"}`)

        return {
            result: 200,
            response: {
                success: true,
                cid: data.cid,
                available: checkResult.available,
                gateway: checkResult.gateway,
                responseTimeMs: checkResult.responseTimeMs,
                error: checkResult.error,
            },
            require_reply: false,
            extra: null,
        }
    } catch (error) {
        log.error(`[IPFS] Public check failed for CID ${data.cid}: ${error}`)

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
