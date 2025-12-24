/**
 * IPFS Unpin NodeCall Handler
 *
 * Unpins content from the local IPFS node, allowing garbage collection.
 *
 * @fileoverview IPFS unpin endpoint
 */

import { RPCResponse } from "@kynesyslabs/demosdk/types"
import log from "@/utilities/logger"
import { ensureIpfsManager } from "./ipfsManager"
import { IPFSInvalidCIDError } from "@/features/ipfs"

interface IpfsUnpinData {
    /** Content Identifier to unpin */
    cid: string
}

/**
 * Unpin content from IPFS node
 *
 * @param data - CID of content to unpin
 * @returns Success status
 */
export default async function ipfsUnpin(data: IpfsUnpinData): Promise<RPCResponse> {
    log.debug(`[IPFS] Received ipfsUnpin request for CID: ${data?.cid}`)

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
        await ipfs.unpin(data.cid)

        log.debug(`[IPFS] Content unpinned: ${data.cid}`)

        return {
            result: 200,
            response: {
                success: true,
                cid: data.cid,
                unpinned: true,
            },
            require_reply: false,
            extra: null,
        }
    } catch (error) {
        log.error(`[IPFS] Unpin failed for CID ${data.cid}: ${error}`)

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
