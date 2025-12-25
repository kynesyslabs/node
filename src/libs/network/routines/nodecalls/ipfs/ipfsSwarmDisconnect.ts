/**
 * IPFS Swarm Disconnect NodeCall Handler
 *
 * Disconnects from a peer by peerId.
 *
 * @fileoverview IPFS swarm disconnect endpoint
 * REVIEW: Phase 4 - Private Network Implementation
 */

import { RPCResponse } from "@kynesyslabs/demosdk/types"
import log from "@/utilities/logger"
import { getIpfsManager } from "./ipfsManager"

interface SwarmDisconnectData {
    peerId: string
}

/**
 * Disconnect from a swarm peer
 *
 * @param data - Disconnection parameters
 * @param data.peerId - The peer ID to disconnect from
 * @returns Disconnection result
 */
export default async function ipfsSwarmDisconnect(
    data: SwarmDisconnectData,
): Promise<RPCResponse> {
    log.debug(`[IPFS] Received ipfsSwarmDisconnect request: ${data?.peerId}`)

    if (!data?.peerId) {
        return {
            result: 400,
            response: {
                success: false,
                error: "peerId is required",
            },
            require_reply: false,
            extra: null,
        }
    }

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

        const success = await ipfs.disconnectPeer(data.peerId)

        // Also unregister from Demos peers if tracked
        if (success) {
            ipfs.unregisterDemosPeer(data.peerId)
        }

        return {
            result: success ? 200 : 400,
            response: {
                success,
                peerId: data.peerId,
            },
            require_reply: false,
            extra: null,
        }
    } catch (error) {
        log.error(`[IPFS] Swarm disconnect failed: ${error}`)
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
