/**
 * IPFS Pin NodeCall Handler
 *
 * Pins content to the local IPFS node to prevent garbage collection.
 *
 * @fileoverview IPFS pin endpoint
 */

import { RPCResponse } from "@kynesyslabs/demosdk/types"
import log from "@/utilities/logger"
import { ensureIpfsManager } from "./ipfsManager"
import { IPFSNotFoundError, IPFSInvalidCIDError } from "@/features/ipfs"

interface IpfsPinData {
    /** Content Identifier to pin */
    cid: string
}

/**
 * Pin content to IPFS node
 *
 * @param data - CID of content to pin
 * @returns Success status
 */
export default async function ipfsPin(data: IpfsPinData): Promise<RPCResponse> {
    log.debug(`[IPFS] Received ipfsPin request for CID: ${data?.cid}`)

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
        await ipfs.pin(data.cid)

        log.debug(`[IPFS] Content pinned: ${data.cid}`)

        return {
            result: 200,
            response: {
                success: true,
                cid: data.cid,
                pinned: true,
            },
            require_reply: false,
            extra: null,
        }
    } catch (error) {
        log.error(`[IPFS] Pin failed for CID ${data.cid}: ${error}`)

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
