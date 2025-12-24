/**
 * IPFS List Pins NodeCall Handler
 *
 * Lists all pinned content CIDs on the local IPFS node.
 *
 * @fileoverview IPFS list pins endpoint
 */

import { RPCResponse } from "@kynesyslabs/demosdk/types"
import log from "@/utilities/logger"
import { ensureIpfsManager } from "./ipfsManager"

/**
 * List all pinned content on IPFS node
 *
 * @returns Array of pinned CIDs
 */
export default async function ipfsListPins(): Promise<RPCResponse> {
    log.debug("[IPFS] Received ipfsListPins request")

    try {
        const ipfs = await ensureIpfsManager()
        const pins = await ipfs.listPins()

        log.debug(`[IPFS] Found ${pins.length} pinned items`)

        return {
            result: 200,
            response: {
                success: true,
                pins,
                count: pins.length,
            },
            require_reply: false,
            extra: null,
        }
    } catch (error) {
        log.error(`[IPFS] List pins failed: ${error}`)

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
