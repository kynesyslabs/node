/**
 * IPFS Get NodeCall Handler
 *
 * Retrieves content from IPFS by CID.
 *
 * @fileoverview IPFS get endpoint
 */

import { RPCResponse } from "@kynesyslabs/demosdk/types"
import log from "@/utilities/logger"
import { ensureIpfsManager } from "./ipfsManager"
import { IPFSNotFoundError, IPFSInvalidCIDError } from "@/features/ipfs"

interface IpfsGetData {
    /** Content Identifier */
    cid: string
    /** Return content as base64 (default: true for binary safety) */
    base64?: boolean
}

/**
 * Get content from IPFS
 *
 * @param data - CID of content to retrieve
 * @returns Content as base64 or text
 */
export default async function ipfsGet(data: IpfsGetData): Promise<RPCResponse> {
    log.debug(`[IPFS] Received ipfsGet request for CID: ${data?.cid}`)

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
        const content = await ipfs.get(data.cid)

        // Default to base64 for binary safety
        const useBase64 = data.base64 !== false

        log.debug(`[IPFS] Content retrieved for CID: ${data.cid} (${content.length} bytes)`)

        return {
            result: 200,
            response: {
                success: true,
                cid: data.cid,
                content: useBase64 ? content.toString("base64") : content.toString(),
                size: content.length,
                base64: useBase64,
            },
            require_reply: false,
            extra: null,
        }
    } catch (error) {
        log.error(`[IPFS] Get failed for CID ${data.cid}: ${error}`)

        if (error instanceof IPFSNotFoundError) {
            return {
                result: 404,
                response: {
                    success: false,
                    error: `Content not found for CID: ${data.cid}`,
                },
                require_reply: false,
                extra: null,
            }
        }

        if (error instanceof IPFSInvalidCIDError) {
            return {
                result: 400,
                response: {
                    success: false,
                    error: `Invalid CID format: ${data.cid}`,
                },
                require_reply: false,
                extra: null,
            }
        }

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
