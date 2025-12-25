/**
 * IPFS Public Fetch NodeCall Handler
 *
 * Fetches content from public IPFS gateways with rate limiting.
 * Part of Phase 5 - Public Bridge implementation.
 *
 * @fileoverview IPFS public fetch endpoint
 *
 * REVIEW: Phase 5 - Public Bridge
 */

import { RPCResponse } from "@kynesyslabs/demosdk/types"
import log from "@/utilities/logger"
import { ensureIpfsManager } from "./ipfsManager"

interface IpfsPublicFetchData {
    /** Content Identifier to fetch from public network */
    cid: string
    /** Return content as base64 (default: true for binary safety) */
    base64?: boolean
}

/**
 * Fetch content from public IPFS gateways
 *
 * This endpoint fetches content from public IPFS gateways (ipfs.io, dweb.link, etc.)
 * when the content is not available on the private Demos network.
 *
 * @param data - CID of content to retrieve from public network
 * @returns Content as base64 or text, with source gateway info
 */
export default async function ipfsPublicFetch(data: IpfsPublicFetchData): Promise<RPCResponse> {
    log.debug(`[IPFS] Received ipfsPublicFetch request for CID: ${data?.cid}`)

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

        const fetchResult = await ipfs.fetchFromPublic(data.cid)

        if (!fetchResult.success || !fetchResult.content) {
            return {
                result: fetchResult.error?.includes("Rate limit") ? 429 : 404,
                response: {
                    success: false,
                    error: fetchResult.error || "Content not found on public gateways",
                },
                require_reply: false,
                extra: null,
            }
        }

        // Default to base64 for binary safety
        const useBase64 = data.base64 !== false

        log.debug(`[IPFS] Public content retrieved for CID: ${data.cid} (${fetchResult.size} bytes from ${fetchResult.gateway})`)

        return {
            result: 200,
            response: {
                success: true,
                cid: data.cid,
                content: useBase64 ? fetchResult.content.toString("base64") : fetchResult.content.toString(),
                size: fetchResult.size,
                base64: useBase64,
                gateway: fetchResult.gateway,
                responseTimeMs: fetchResult.responseTimeMs,
            },
            require_reply: false,
            extra: null,
        }
    } catch (error) {
        log.error(`[IPFS] Public fetch failed for CID ${data.cid}: ${error}`)

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
