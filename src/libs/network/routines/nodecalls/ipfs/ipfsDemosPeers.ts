/**
 * IPFS Demos Peers NodeCall Handler
 *
 * Returns the list of known Demos network peers in the IPFS swarm.
 *
 * @fileoverview IPFS Demos peers endpoint
 * REVIEW: Phase 4 - Private Network Implementation
 */

import { RPCResponse } from "@kynesyslabs/demosdk/types"
import log from "@/utilities/logger"
import { getIpfsManager } from "./ipfsManager"

/**
 * Get known Demos network peers
 *
 * @returns List of Demos network peers with their IPFS multiaddresses
 */
export default async function ipfsDemosPeers(): Promise<RPCResponse> {
    log.debug("[IPFS] Received ipfsDemosPeers request")

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

        const demosPeers = ipfs.getDemosPeers()
        const peers: Array<{ peerId: string; multiaddr: string }> = []

        demosPeers.forEach((multiaddr, peerId) => {
            peers.push({ peerId, multiaddr })
        })

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
        log.error(`[IPFS] Demos peers request failed: ${error}`)
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
