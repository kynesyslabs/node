/**
 * IPFS Swarm Peers NodeCall Handler
 *
 * Returns the list of connected swarm peers with their status.
 *
 * @fileoverview IPFS swarm peers endpoint
 * REVIEW: Phase 4 - Private Network Implementation
 */

import { RPCResponse } from "@kynesyslabs/demosdk/types"
import log from "@/utilities/logger"
import { getIpfsManager } from "./ipfsManager"

/**
 * Get connected swarm peers
 *
 * @returns List of connected peers with peerId, address, direction, latency
 */
export default async function ipfsSwarmPeers(): Promise<RPCResponse> {
    log.debug("[IPFS] Received ipfsSwarmPeers request")

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

        const peers = await ipfs.getSwarmPeers()

        return {
            result: 200,
            response: {
                success: true,
                peers,
                count: peers.length,
                isPrivateNetwork: ipfs.isPrivateNetwork(),
            },
            require_reply: false,
            extra: null,
        }
    } catch (error) {
        log.error(`[IPFS] Swarm peers request failed: ${error}`)
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
