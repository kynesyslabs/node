/**
 * IPFS Swarm Connect NodeCall Handler
 *
 * Connects to a peer by multiaddress.
 *
 * @fileoverview IPFS swarm connect endpoint
 * REVIEW: Phase 4 - Private Network Implementation
 */

import { RPCResponse } from "@kynesyslabs/demosdk/types"
import log from "@/utilities/logger"
import { getIpfsManager } from "./ipfsManager"

interface SwarmConnectData {
    multiaddr: string
    isDemosNode?: boolean
}

/**
 * Connect to a swarm peer
 *
 * @param data - Connection parameters
 * @param data.multiaddr - The multiaddress of the peer to connect to
 * @param data.isDemosNode - Optional flag to mark peer as Demos network node
 * @returns Connection result with success status and peerId
 */
export default async function ipfsSwarmConnect(
    data: SwarmConnectData,
): Promise<RPCResponse> {
    log.debug(`[IPFS] Received ipfsSwarmConnect request: ${data?.multiaddr}`)

    if (!data?.multiaddr) {
        return {
            result: 400,
            response: {
                success: false,
                error: "multiaddr is required",
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

        const result = await ipfs.connectPeer(data.multiaddr)

        // If connection successful and marked as Demos node, register it
        if (result.success && result.peerId && data.isDemosNode) {
            ipfs.registerDemosPeer(result.peerId, data.multiaddr)
        }

        return {
            result: result.success ? 200 : 400,
            response: {
                success: result.success,
                peerId: result.peerId,
                error: result.error,
            },
            require_reply: false,
            extra: null,
        }
    } catch (error) {
        log.error(`[IPFS] Swarm connect failed: ${error}`)
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
