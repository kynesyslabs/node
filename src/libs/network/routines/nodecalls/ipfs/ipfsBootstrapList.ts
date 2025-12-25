/**
 * IPFS Bootstrap List NodeCall Handler
 *
 * Returns the list of bootstrap nodes configured for the IPFS node.
 *
 * @fileoverview IPFS bootstrap list endpoint
 * REVIEW: Phase 4 - Private Network Implementation
 */

import { RPCResponse } from "@kynesyslabs/demosdk/types"
import log from "@/utilities/logger"
import { getIpfsManager } from "./ipfsManager"

/**
 * Get bootstrap node list
 *
 * @returns List of bootstrap nodes with multiaddresses
 */
export default async function ipfsBootstrapList(): Promise<RPCResponse> {
    log.debug("[IPFS] Received ipfsBootstrapList request")

    try {
        const ipfs = getIpfsManager()

        if (!ipfs) {
            return {
                result: 503,
                response: {
                    success: false,
                    error: "IPFS not initialized",
                },
                require_reply: false,
                extra: null,
            }
        }

        const bootstrapNodes = await ipfs.getBootstrapList()
        const swarmConfig = ipfs.getSwarmConfig()

        return {
            result: 200,
            response: {
                success: true,
                bootstrapNodes,
                count: bootstrapNodes.length,
                isPrivateNetwork: ipfs.isPrivateNetwork(),
                configuredNodes: swarmConfig.bootstrapNodes,
            },
            require_reply: false,
            extra: null,
        }
    } catch (error) {
        log.error(`[IPFS] Bootstrap list request failed: ${error}`)
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
