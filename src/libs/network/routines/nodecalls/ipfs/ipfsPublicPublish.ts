/**
 * IPFS Public Publish NodeCall Handler
 *
 * Publishes/announces content to public IPFS network via DHT provide.
 * Part of Phase 5 - Public Bridge implementation.
 *
 * @fileoverview IPFS public publish endpoint
 *
 * REVIEW: Phase 5 - Public Bridge
 */

import { RPCResponse } from "@kynesyslabs/demosdk/types"
import log from "@/utilities/logger"
import { ensureIpfsManager } from "./ipfsManager"

interface IpfsPublicPublishData {
    /** Content Identifier to publish to public network */
    cid: string
}

/**
 * Publish content to public IPFS network
 *
 * This endpoint announces locally-pinned content to the public IPFS DHT,
 * making it discoverable and retrievable by public IPFS nodes.
 *
 * @param data - CID of content to publish to public network
 * @returns Success status and published CID
 */
export default async function ipfsPublicPublish(data: IpfsPublicPublishData): Promise<RPCResponse> {
    log.debug(`[IPFS] Received ipfsPublicPublish request for CID: ${data?.cid}`)

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

        const publishResult = await ipfs.publishToPublic(data.cid)

        if (!publishResult.success) {
            const statusCode = publishResult.error?.includes("Rate limit")
                ? 429
                : publishResult.error?.includes("not allowed")
                    ? 403
                    : 500

            return {
                result: statusCode,
                response: {
                    success: false,
                    error: publishResult.error || "Failed to publish to public network",
                },
                require_reply: false,
                extra: null,
            }
        }

        log.info(`[IPFS] Content published to public network: ${data.cid}`)

        return {
            result: 200,
            response: {
                success: true,
                cid: publishResult.cid,
                message: "Content announced to public IPFS DHT",
            },
            require_reply: false,
            extra: null,
        }
    } catch (error) {
        log.error(`[IPFS] Public publish failed for CID ${data.cid}: ${error}`)

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
