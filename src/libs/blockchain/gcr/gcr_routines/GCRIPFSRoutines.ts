/**
 * GCR IPFS Routines
 *
 * Helper methods for managing IPFS state in user accounts.
 * Provides pin management, reward tracking, and state queries.
 *
 * @fileoverview IPFS account state management routines
 */

import { Repository } from "typeorm"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import {
    type PinnedContent,
    type AccountIPFSState,
    DEFAULT_IPFS_STATE,
} from "@/model/entities/types/IPFSTypes"
import Datasource from "@/model/datasource"
import log from "@/utilities/logger"

// REVIEW: Per-pubkey locks to prevent race conditions in concurrent pin operations
const pendingOperations = new Map<string, Promise<unknown>>()

/**
 * Execute an operation with per-pubkey locking to prevent race conditions.
 * Ensures only one operation per pubkey runs at a time.
 */
async function withPubkeyLock<T>(
    pubkey: string,
    operation: () => Promise<T>,
): Promise<T> {
    // Wait for any pending operation on this pubkey
    const pending = pendingOperations.get(pubkey)
    if (pending) {
        await pending.catch(() => {}) // Ignore errors from previous operation
    }

    // Create and track this operation
    const currentOp = operation()
    pendingOperations.set(pubkey, currentOp)

    try {
        return await currentOp
    } finally {
        // Clean up if this is still the tracked operation
        if (pendingOperations.get(pubkey) === currentOp) {
            pendingOperations.delete(pubkey)
        }
    }
}

/**
 * Result type for IPFS operations
 */
export interface OperationResult {
    success: boolean
    message: string
    data?: unknown
}

/**
 * GCR IPFS Routines class
 *
 * Provides static methods for IPFS state management in account records.
 */
export default class GCRIPFSRoutines {
    /**
     * Get the IPFS state for an account
     *
     * @param pubkey - Account public key
     * @param repository - Optional repository (uses default if not provided)
     * @returns Account IPFS state or default state if not found
     */
    static async getIPFSState(
        pubkey: string,
        repository?: Repository<GCRMain>,
    ): Promise<AccountIPFSState> {
        const repo = repository ?? (await GCRIPFSRoutines.getRepository())

        const account = await repo.findOneBy({ pubkey })
        if (!account || !account.ipfs) {
            return { ...DEFAULT_IPFS_STATE }
        }

        // Ensure the state has all required fields (backward compatibility)
        return {
            pins: account.ipfs.pins ?? [],
            totalPinnedBytes: account.ipfs.totalPinnedBytes ?? 0,
            earnedRewards: account.ipfs.earnedRewards ?? "0",
            paidCosts: account.ipfs.paidCosts ?? "0",
            freeAllocationBytes: account.ipfs.freeAllocationBytes ?? 0,
            usedFreeBytes: account.ipfs.usedFreeBytes ?? 0,
            lastUpdated: account.ipfs.lastUpdated,
        }
    }

    /**
     * Add a pin to an account's IPFS state
     *
     * @param pubkey - Account public key
     * @param pin - Pin to add
     * @param repository - Optional repository
     * @returns Operation result
     */
    static async addPin(
        pubkey: string,
        pin: PinnedContent,
        repository?: Repository<GCRMain>,
    ): Promise<OperationResult> {
        // REVIEW: Use per-pubkey lock to prevent race conditions
        return withPubkeyLock(pubkey, async () => {
            const repo = repository ?? (await GCRIPFSRoutines.getRepository())

            try {
                const account = await repo.findOneBy({ pubkey })
                if (!account) {
                    return { success: false, message: "Account not found" }
                }

                // Initialize IPFS state if needed
                const ipfsState = account.ipfs ?? { ...DEFAULT_IPFS_STATE }

                // Check if pin already exists
                const existingIndex = ipfsState.pins?.findIndex(
                    (p) => p.cid === pin.cid,
                )
                if (existingIndex !== undefined && existingIndex >= 0) {
                    return { success: false, message: "Pin already exists" }
                }

                // Add the pin
                if (!ipfsState.pins) {
                    ipfsState.pins = []
                }
                ipfsState.pins.push(pin)

                // Update totals
                ipfsState.totalPinnedBytes =
                    (ipfsState.totalPinnedBytes ?? 0) + pin.size
                ipfsState.lastUpdated = Date.now()

                // Save
                account.ipfs = ipfsState
                await repo.save(account)

                log.debug(`[GCRIPFSRoutines] Added pin ${pin.cid} for ${pubkey}`)

                return {
                    success: true,
                    message: "Pin added",
                    data: { cid: pin.cid, size: pin.size },
                }
            } catch (error) {
                log.error(`[GCRIPFSRoutines] Failed to add pin: ${error}`)
                return {
                    success: false,
                    message: error instanceof Error ? error.message : "Unknown error",
                }
            }
        })
    }

    /**
     * Remove a pin from an account's IPFS state
     *
     * @param pubkey - Account public key
     * @param cid - CID of the pin to remove
     * @param repository - Optional repository
     * @returns Operation result with removed pin data
     */
    static async removePin(
        pubkey: string,
        cid: string,
        repository?: Repository<GCRMain>,
    ): Promise<OperationResult> {
        // REVIEW: Use per-pubkey lock to prevent race conditions
        return withPubkeyLock(pubkey, async () => {
            const repo = repository ?? (await GCRIPFSRoutines.getRepository())

            try {
                const account = await repo.findOneBy({ pubkey })
                if (!account) {
                    return { success: false, message: "Account not found" }
                }

                const ipfsState = account.ipfs
                if (!ipfsState?.pins?.length) {
                    return { success: false, message: "No pins found" }
                }

                // Find the pin
                const pinIndex = ipfsState.pins.findIndex((p) => p.cid === cid)
                if (pinIndex === -1) {
                    return { success: false, message: "Pin not found" }
                }

                // Remove and update totals
                const [removedPin] = ipfsState.pins.splice(pinIndex, 1)
                ipfsState.totalPinnedBytes = Math.max(
                    0,
                    (ipfsState.totalPinnedBytes ?? 0) - removedPin.size,
                )
                ipfsState.lastUpdated = Date.now()

                // Save
                account.ipfs = ipfsState
                await repo.save(account)

                log.debug(`[GCRIPFSRoutines] Removed pin ${cid} for ${pubkey}`)

                return {
                    success: true,
                    message: "Pin removed",
                    data: removedPin,
                }
            } catch (error) {
                log.error(`[GCRIPFSRoutines] Failed to remove pin: ${error}`)
                return {
                    success: false,
                    message: error instanceof Error ? error.message : "Unknown error",
                }
            }
        })
    }

    /**
     * Get all pins for an account
     *
     * @param pubkey - Account public key
     * @param repository - Optional repository
     * @returns Array of pins
     */
    static async getPins(
        pubkey: string,
        repository?: Repository<GCRMain>,
    ): Promise<PinnedContent[]> {
        const state = await GCRIPFSRoutines.getIPFSState(pubkey, repository)
        return state.pins
    }

    /**
     * Check if a specific CID is pinned by an account
     *
     * @param pubkey - Account public key
     * @param cid - CID to check
     * @param repository - Optional repository
     * @returns True if pinned
     */
    static async isPinned(
        pubkey: string,
        cid: string,
        repository?: Repository<GCRMain>,
    ): Promise<boolean> {
        const pins = await GCRIPFSRoutines.getPins(pubkey, repository)
        return pins.some((p) => p.cid === cid)
    }

    /**
     * Update rewards for an account
     *
     * @param pubkey - Account public key
     * @param amount - Amount to add to rewards (can be negative for deduction)
     * @param repository - Optional repository
     * @returns Operation result
     */
    static async updateRewards(
        pubkey: string,
        amount: bigint,
        repository?: Repository<GCRMain>,
    ): Promise<OperationResult> {
        const repo = repository ?? (await GCRIPFSRoutines.getRepository())

        try {
            const account = await repo.findOneBy({ pubkey })
            if (!account) {
                return { success: false, message: "Account not found" }
            }

            const ipfsState = account.ipfs ?? { ...DEFAULT_IPFS_STATE }
            const currentRewards = BigInt(ipfsState.earnedRewards ?? "0")
            const newRewards = currentRewards + amount

            // Prevent negative rewards
            if (newRewards < 0n) {
                return { success: false, message: "Insufficient rewards" }
            }

            ipfsState.earnedRewards = newRewards.toString()
            ipfsState.lastUpdated = Date.now()

            account.ipfs = ipfsState
            await repo.save(account)

            log.debug(
                `[GCRIPFSRoutines] Updated rewards for ${pubkey}: ${amount} (total: ${newRewards})`,
            )

            return {
                success: true,
                message: "Rewards updated",
                data: { earnedRewards: ipfsState.earnedRewards },
            }
        } catch (error) {
            log.error(`[GCRIPFSRoutines] Failed to update rewards: ${error}`)
            return {
                success: false,
                message: error instanceof Error ? error.message : "Unknown error",
            }
        }
    }

    /**
     * Update costs for an account
     *
     * @param pubkey - Account public key
     * @param amount - Amount to add to costs
     * @param repository - Optional repository
     * @returns Operation result
     */
    static async updateCosts(
        pubkey: string,
        amount: bigint,
        repository?: Repository<GCRMain>,
    ): Promise<OperationResult> {
        const repo = repository ?? (await GCRIPFSRoutines.getRepository())

        try {
            const account = await repo.findOneBy({ pubkey })
            if (!account) {
                return { success: false, message: "Account not found" }
            }

            const ipfsState = account.ipfs ?? { ...DEFAULT_IPFS_STATE }
            const currentCosts = BigInt(ipfsState.paidCosts ?? "0")
            ipfsState.paidCosts = (currentCosts + amount).toString()
            ipfsState.lastUpdated = Date.now()

            account.ipfs = ipfsState
            await repo.save(account)

            log.debug(
                `[GCRIPFSRoutines] Updated costs for ${pubkey}: ${amount} (total: ${ipfsState.paidCosts})`,
            )

            return {
                success: true,
                message: "Costs updated",
                data: { paidCosts: ipfsState.paidCosts },
            }
        } catch (error) {
            log.error(`[GCRIPFSRoutines] Failed to update costs: ${error}`)
            return {
                success: false,
                message: error instanceof Error ? error.message : "Unknown error",
            }
        }
    }

    /**
     * Get IPFS statistics for an account
     *
     * @param pubkey - Account public key
     * @param repository - Optional repository
     * @returns IPFS statistics
     */
    static async getStats(
        pubkey: string,
        repository?: Repository<GCRMain>,
    ): Promise<{
        pinCount: number
        totalBytes: number
        earnedRewards: string
        paidCosts: string
        netBalance: string
    }> {
        const state = await GCRIPFSRoutines.getIPFSState(pubkey, repository)
        const earned = BigInt(state.earnedRewards)
        const paid = BigInt(state.paidCosts)

        return {
            pinCount: state.pins.length,
            totalBytes: state.totalPinnedBytes,
            earnedRewards: state.earnedRewards,
            paidCosts: state.paidCosts,
            netBalance: (earned - paid).toString(),
        }
    }

    /**
     * Clean up expired pins for an account
     *
     * @param pubkey - Account public key
     * @param repository - Optional repository
     * @returns Operation result with count of removed pins
     */
    static async cleanupExpiredPins(
        pubkey: string,
        repository?: Repository<GCRMain>,
    ): Promise<OperationResult> {
        const repo = repository ?? (await GCRIPFSRoutines.getRepository())

        try {
            const account = await repo.findOneBy({ pubkey })
            if (!account?.ipfs?.pins?.length) {
                return { success: true, message: "No pins to cleanup", data: { removed: 0 } }
            }

            const now = Date.now()
            const ipfsState = account.ipfs
            const originalCount = ipfsState.pins.length

            // Filter out expired pins
            const expiredPins = ipfsState.pins.filter(
                (p) => p.expiresAt && p.expiresAt < now,
            )
            ipfsState.pins = ipfsState.pins.filter(
                (p) => !p.expiresAt || p.expiresAt >= now,
            )

            // Update totals
            const removedBytes = expiredPins.reduce((sum, p) => sum + p.size, 0)
            ipfsState.totalPinnedBytes = Math.max(
                0,
                (ipfsState.totalPinnedBytes ?? 0) - removedBytes,
            )
            ipfsState.lastUpdated = Date.now()

            // Save
            account.ipfs = ipfsState
            await repo.save(account)

            const removedCount = originalCount - ipfsState.pins.length
            log.debug(
                `[GCRIPFSRoutines] Cleaned up ${removedCount} expired pins for ${pubkey}`,
            )

            return {
                success: true,
                message: `Removed ${removedCount} expired pins`,
                data: { removed: removedCount, bytesFreed: removedBytes },
            }
        } catch (error) {
            log.error(`[GCRIPFSRoutines] Failed to cleanup expired pins: ${error}`)
            return {
                success: false,
                message: error instanceof Error ? error.message : "Unknown error",
            }
        }
    }

    /**
     * Get the repository instance
     */
    private static async getRepository(): Promise<Repository<GCRMain>> {
        const db = await Datasource.getInstance()
        return db.getDataSource().getRepository(GCRMain)
    }
}
