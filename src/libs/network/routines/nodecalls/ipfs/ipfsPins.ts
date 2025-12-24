/**
 * IPFS Pins NodeCall Handler
 *
 * Returns pinned content for a specific account address from account state.
 * This is different from ipfsListPins which lists all pins on the IPFS node.
 *
 * @fileoverview Account-based IPFS pins query endpoint
 */

import { RPCResponse } from "@kynesyslabs/demosdk/types"
import log from "@/utilities/logger"
import gcrRoutines from "@/libs/blockchain/gcr/gcr_routines"

interface IpfsPinsData {
    /** Account address (pubkey) to query pins for */
    address: string
}

/**
 * Get pinned content for a specific account
 *
 * Reads from the account's IPFS state in the GCR database.
 *
 * @param data - Account address to query
 * @returns Array of pins associated with the account
 */
export default async function ipfsPins(data: IpfsPinsData): Promise<RPCResponse> {
    log.debug(`[IPFS] Received ipfsPins request for address: ${data?.address}`)

    if (!data?.address) {
        return {
            result: 400,
            response: {
                success: false,
                error: "No address provided",
            },
            require_reply: false,
            extra: null,
        }
    }

    try {
        // Get IPFS state from account record
        const ipfsState = await gcrRoutines.ipfs.getIPFSState(data.address)

        log.debug(
            `[IPFS] Found ${ipfsState.pins.length} pins for address: ${data.address}`,
        )

        return {
            result: 200,
            response: {
                success: true,
                address: data.address,
                pins: ipfsState.pins,
                count: ipfsState.pins.length,
                totalPinnedBytes: ipfsState.totalPinnedBytes,
                earnedRewards: ipfsState.earnedRewards,
                paidCosts: ipfsState.paidCosts,
            },
            require_reply: false,
            extra: null,
        }
    } catch (error) {
        log.error(`[IPFS] Pins query failed for address ${data.address}: ${error}`)

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
