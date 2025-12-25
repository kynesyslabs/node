/**
 * IPFS Cluster Pin NodeCall Handler
 *
 * Pins content across multiple Demos network nodes for redundancy.
 *
 * @fileoverview IPFS cluster pin endpoint
 * REVIEW: Phase 4 - Private Network Implementation
 */

import { RPCResponse } from "@kynesyslabs/demosdk/types"
import log from "@/utilities/logger"
import { getIpfsManager } from "./ipfsManager"
import type { ClusterPinOptions } from "@/features/ipfs/types"

interface ClusterPinData {
    cid: string
    replication?: number
    name?: string
    expiresAt?: number
    metadata?: Record<string, unknown>
}

/**
 * Pin content across cluster nodes
 *
 * @param data - Cluster pin parameters
 * @param data.cid - Content identifier to pin
 * @param data.replication - Target replication factor (default: 3)
 * @param data.name - Optional name/label for the pin
 * @param data.expiresAt - Optional expiration timestamp
 * @param data.metadata - Optional metadata
 * @returns Cluster pin result with replication status
 */
export default async function ipfsClusterPin(
    data: ClusterPinData,
): Promise<RPCResponse> {
    log.debug(`[IPFS] Received ipfsClusterPin request: ${data?.cid}`)

    if (!data?.cid) {
        return {
            result: 400,
            response: {
                success: false,
                error: "cid is required",
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

        const options: ClusterPinOptions = {
            replication: data.replication,
            name: data.name,
            expiresAt: data.expiresAt,
            metadata: data.metadata,
        }

        const result = await ipfs.clusterPin(data.cid, options)

        return {
            result: 200,
            response: {
                success: true,
                cid: result.cid,
                replicatedTo: result.replicatedTo,
                targetReplication: result.targetReplication,
                pinnedBy: result.pinnedBy,
                errors: result.errors,
            },
            require_reply: false,
            extra: null,
        }
    } catch (error) {
        log.error(`[IPFS] Cluster pin failed: ${error}`)
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
