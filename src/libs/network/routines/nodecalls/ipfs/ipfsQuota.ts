/**
 * IPFS Quota NodeCall Handler
 *
 * Returns the current IPFS storage quota status for an account.
 * Allows users to check their quota before submitting IPFS transactions.
 *
 * @fileoverview IPFS quota check endpoint (DEM-480)
 */

import { RPCResponse } from "@kynesyslabs/demosdk/types"
import log from "@/utilities/logger"
import GCRIPFSRoutines from "@/libs/blockchain/gcr/gcr_routines/GCRIPFSRoutines"
import { isGenesisAccount } from "@/libs/blockchain/routines/ipfsTokenomics"
import {
    getQuotaForTier,
    QuotaTier,
    QuotaCheckResult,
} from "@/model/entities/types/IPFSTypes"

interface IpfsQuotaData {
    /** Account address to check quota for */
    address: string
}

interface QuotaResponse {
    success: boolean
    /** Account address */
    address: string
    /** Account tier (regular, genesis, premium) */
    tier: QuotaTier
    /** Current storage usage in bytes */
    usedBytes: number
    /** Maximum storage allowed in bytes */
    maxBytes: number
    /** Remaining storage available in bytes */
    remainingBytes: number
    /** Current number of pins */
    pinCount: number
    /** Maximum number of pins allowed */
    maxPins: number
    /** Remaining pins available */
    remainingPins: number
    /** Human-readable usage percentage */
    usagePercent: number
    /** Free tier usage (genesis accounts) */
    freeTier?: {
        /** Free allocation in bytes */
        allocation: number
        /** Used free bytes */
        used: number
        /** Remaining free bytes */
        remaining: number
    }
}

/**
 * Get IPFS quota status for an account
 *
 * @param data - Account address to check
 * @returns Quota status including usage, limits, and remaining capacity
 */
export default async function ipfsQuota(data: IpfsQuotaData): Promise<RPCResponse> {
    log.debug(`[IPFS] Received ipfsQuota request for address: ${data?.address}`)

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
        // Get account IPFS state
        const ipfsState = await GCRIPFSRoutines.getIPFSState(data.address)
        const isGenesis = await isGenesisAccount(data.address)

        // Determine tier and get quota limits
        const tier: QuotaTier = isGenesis ? "genesis" : "regular"
        const quota = getQuotaForTier(tier)

        // Calculate quota status
        const usedBytes = ipfsState.totalPinnedBytes
        const pinCount = ipfsState.pins.length
        const remainingBytes = Math.max(0, quota.maxPinnedBytes - usedBytes)
        const remainingPins = Math.max(0, quota.maxPinCount - pinCount)
        const usagePercent = quota.maxPinnedBytes > 0
            ? Math.round((usedBytes / quota.maxPinnedBytes) * 10000) / 100
            : 0

        const response: QuotaResponse = {
            success: true,
            address: data.address,
            tier,
            usedBytes,
            maxBytes: quota.maxPinnedBytes,
            remainingBytes,
            pinCount,
            maxPins: quota.maxPinCount,
            remainingPins,
            usagePercent,
        }

        // Add free tier info for genesis accounts
        if (isGenesis && ipfsState.freeAllocationBytes > 0) {
            response.freeTier = {
                allocation: ipfsState.freeAllocationBytes,
                used: ipfsState.usedFreeBytes,
                remaining: Math.max(0, ipfsState.freeAllocationBytes - ipfsState.usedFreeBytes),
            }
        }

        log.debug(
            `[IPFS] Quota check for ${data.address}: ${usedBytes}/${quota.maxPinnedBytes} bytes (${usagePercent}%)`,
        )

        return {
            result: 200,
            response,
            require_reply: false,
            extra: null,
        }
    } catch (error) {
        log.error(`[IPFS] Quota check failed for ${data.address}: ${error}`)
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
