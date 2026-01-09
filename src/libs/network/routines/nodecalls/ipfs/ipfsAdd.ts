/**
 * IPFS Add NodeCall Handler
 *
 * Adds content to IPFS and returns the CID.
 *
 * @fileoverview IPFS add endpoint
 */

import { RPCResponse } from "@kynesyslabs/demosdk/types"
import log from "@/utilities/logger"
import { ensureIpfsManager } from "./ipfsManager"

interface IpfsAddData {
    /** Content as base64 encoded string or plain text */
    content: string
    /** Optional filename */
    filename?: string
    /** If true, content is base64 encoded */
    base64?: boolean
}

/**
 * Add content to IPFS
 *
 * @param data - Content data with optional filename
 * @returns CID of the added content
 */
export default async function ipfsAdd(data: IpfsAddData): Promise<RPCResponse> {
    log.debug("[IPFS] Received ipfsAdd request")

    if (!data?.content) {
        return {
            result: 400,
            response: {
                success: false,
                error: "No content provided",
            },
            require_reply: false,
            extra: null,
        }
    }

    // REVIEW: DoS prevention - limit content size before buffer allocation
    // Max 16MB matches MessageFramer.MAX_PAYLOAD_SIZE for consistency
    const MAX_CONTENT_SIZE = 16 * 1024 * 1024
    const contentLength = data.content.length
    // Base64 encoded content is ~33% larger than raw, so decoded size is ~75% of encoded
    const estimatedDecodedSize = data.base64 ? Math.ceil(contentLength * 0.75) : contentLength

    if (estimatedDecodedSize > MAX_CONTENT_SIZE) {
        return {
            result: 413,
            response: {
                success: false,
                error: `Content too large: estimated ${estimatedDecodedSize} bytes exceeds maximum ${MAX_CONTENT_SIZE} bytes`,
            },
            require_reply: false,
            extra: null,
        }
    }

    try {
        const ipfs = await ensureIpfsManager()

        // Decode content if base64 encoded
        let contentBuffer: Buffer
        if (data.base64) {
            contentBuffer = Buffer.from(data.content, "base64")
        } else {
            contentBuffer = Buffer.from(data.content)
        }

        // REVIEW: Final size check after decoding (in case estimate was off)
        if (contentBuffer.length > MAX_CONTENT_SIZE) {
            return {
                result: 413,
                response: {
                    success: false,
                    error: `Content too large: ${contentBuffer.length} bytes exceeds maximum ${MAX_CONTENT_SIZE} bytes`,
                },
                require_reply: false,
                extra: null,
            }
        }

        const cid = await ipfs.add(contentBuffer, data.filename)

        log.debug(`[IPFS] Content added with CID: ${cid}`)

        return {
            result: 200,
            response: {
                success: true,
                cid,
                size: contentBuffer.length,
            },
            require_reply: false,
            extra: null,
        }
    } catch (error) {
        log.error(`[IPFS] Add failed: ${error}`)
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
