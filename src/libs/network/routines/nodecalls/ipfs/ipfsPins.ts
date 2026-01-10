/**
 * IPFS Pins NodeCall Handler
 *
 * Returns pinned content for a specific account address from account state.
 * This is different from ipfsListPins which lists all pins on the IPFS node.
 *
 * REVIEW: DEM-481 - Added expiration info to response
 *
 * @fileoverview Account-based IPFS pins query endpoint
 */

import { RPCResponse } from "@kynesyslabs/demosdk/types"
import log from "@/utilities/logger"
import gcrRoutines from "@/libs/blockchain/gcr/gcr_routines"
import { isPinExpired, type PinnedContent } from "@/model/entities/types/IPFSTypes"

interface IpfsPinsData {
    /** Account address (pubkey) to query pins for */
    address: string
}

// REVIEW: DEM-481 - Helper to calculate expiration summary
interface ExpirationSummary {
    /** Total number of permanent pins */
    permanentCount: number
    /** Total number of pins with expiration date */
    expiringCount: number
    /** Number of pins that have already expired */
    expiredCount: number
    /** Number of pins expiring within the next 7 days */
    expiringWithin7Days: number
    /** Number of pins expiring within the next 30 days */
    expiringWithin30Days: number
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
        // REVIEW: Null safety - ensure pins array exists
        const pins = ipfsState?.pins ?? []

        log.debug(
            `[IPFS] Found ${pins.length} pins for address: ${data.address}`,
        )

        // REVIEW: DEM-481 - Calculate expiration summary
        const expirationSummary = calculateExpirationSummary(pins)

        return {
            result: 200,
            response: {
                success: true,
                address: data.address,
                pins: pins,
                count: pins.length,
                totalPinnedBytes: ipfsState?.totalPinnedBytes ?? 0,
                earnedRewards: ipfsState?.earnedRewards ?? "0",
                paidCosts: ipfsState?.paidCosts ?? "0",
                // REVIEW: DEM-481 - Added expiration summary
                expiration: expirationSummary,
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

// REVIEW: DEM-481 - Calculate expiration summary for pins
function calculateExpirationSummary(pins: PinnedContent[]): ExpirationSummary {
    const now = Date.now()
    const sevenDaysFromNow = now + 7 * 24 * 60 * 60 * 1000
    const thirtyDaysFromNow = now + 30 * 24 * 60 * 60 * 1000

    let permanentCount = 0
    let expiringCount = 0
    let expiredCount = 0
    let expiringWithin7Days = 0
    let expiringWithin30Days = 0

    for (const pin of pins) {
        if (!pin.expiresAt) {
            // No expiration = permanent
            permanentCount++
        } else if (isPinExpired(pin, now)) {
            // Already expired
            expiredCount++
            expiringCount++
        } else {
            // Has expiration and not yet expired
            expiringCount++
            if (pin.expiresAt <= sevenDaysFromNow) {
                expiringWithin7Days++
            }
            if (pin.expiresAt <= thirtyDaysFromNow) {
                expiringWithin30Days++
            }
        }
    }

    return {
        permanentCount,
        expiringCount,
        expiredCount,
        expiringWithin7Days,
        expiringWithin30Days,
    }
}
