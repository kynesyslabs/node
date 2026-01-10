/**
 * IPFS Pin Expiration Worker
 *
 * Background service that monitors and manages expired IPFS pins.
 * Runs periodically to identify expired pins and trigger cleanup.
 *
 * REVIEW: DEM-481 - IPFS Pin Expiration System
 *
 * @fileoverview Background worker for IPFS pin expiration management
 */

import log from "@/utilities/logger"
import { getIpfsManager } from "@/libs/network/routines/nodecalls/ipfs/ipfsManager"
import GCRIPFSRoutines from "@/libs/blockchain/gcr/gcr_routines/GCRIPFSRoutines"
import { getExpiredPins, isPinExpired, PinnedContent } from "@/model/entities/types/IPFSTypes"
import Datasource from "@/model/datasource"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { getSharedState } from "@/utilities/sharedState"

/**
 * Configuration for the expiration worker
 */
export interface ExpirationWorkerConfig {
    /** Interval between expiration checks in milliseconds (default: 1 hour) */
    checkIntervalMs: number
    /** Grace period before actual cleanup in milliseconds (default: 24 hours) */
    gracePeriodMs: number
    /** Maximum pins to process per check cycle (default: 100) */
    batchSize: number
    /** Whether to actually unpin content or just mark as expired (default: true) */
    enableUnpin: boolean
    /** Enable verbose logging (default: false) */
    verbose: boolean
}

/**
 * Statistics for expiration worker operations
 */
export interface ExpirationStats {
    lastCheckTimestamp: number
    totalExpiredFound: number
    totalUnpinned: number
    totalGraceExpired: number
    lastError?: string
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: ExpirationWorkerConfig = {
    checkIntervalMs: 60 * 60 * 1000, // 1 hour
    gracePeriodMs: 24 * 60 * 60 * 1000, // 24 hours
    batchSize: 100,
    enableUnpin: true,
    verbose: false,
}

/**
 * IPFS Pin Expiration Worker
 *
 * Manages the lifecycle of expired pins through:
 * 1. Periodic scanning of all account IPFS states
 * 2. Identification of pins past their expiresAt timestamp
 * 3. Grace period enforcement before cleanup
 * 4. Actual unpin operations when grace period expires
 */
export class ExpirationWorker {
    private config: ExpirationWorkerConfig
    private intervalHandle: ReturnType<typeof setInterval> | null = null
    private isRunning = false
    private stats: ExpirationStats = {
        lastCheckTimestamp: 0,
        totalExpiredFound: 0,
        totalUnpinned: 0,
        totalGraceExpired: 0,
    }

    constructor(config: Partial<ExpirationWorkerConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config }
    }

    /**
     * Start the expiration worker
     */
    start(): void {
        if (this.isRunning) {
            log.warning("[ExpirationWorker] Already running, ignoring start request")
            return
        }

        log.info(
            `[ExpirationWorker] Starting with config: checkInterval=${this.config.checkIntervalMs}ms, gracePeriod=${this.config.gracePeriodMs}ms`,
        )

        this.isRunning = true

        // Run initial check after a short delay
        setTimeout(() => this.runExpirationCheck(), 5000)

        // Schedule periodic checks
        this.intervalHandle = setInterval(() => {
            this.runExpirationCheck()
        }, this.config.checkIntervalMs)
    }

    /**
     * Stop the expiration worker
     */
    stop(): void {
        if (!this.isRunning) {
            return
        }

        log.info("[ExpirationWorker] Stopping")
        this.isRunning = false

        if (this.intervalHandle) {
            clearInterval(this.intervalHandle)
            this.intervalHandle = null
        }
    }

    /**
     * Get current worker statistics
     */
    getStats(): ExpirationStats {
        return { ...this.stats }
    }

    /**
     * Run a single expiration check cycle
     */
    async runExpirationCheck(): Promise<void> {
        if (!this.isRunning) {
            return
        }

        const currentTimestamp = Date.now()
        const graceTimestamp = currentTimestamp - this.config.gracePeriodMs

        if (this.config.verbose) {
            log.debug(
                `[ExpirationWorker] Running check at ${currentTimestamp}, grace threshold=${graceTimestamp}`,
            )
        }

        try {
            // Get all accounts with IPFS state
            const accounts = await this.getAllAccountsWithIPFS()

            let totalExpired = 0
            let totalUnpinned = 0

            for (const account of accounts) {
                const result = await this.processAccountExpiredPins(
                    account,
                    currentTimestamp,
                    graceTimestamp,
                )
                totalExpired += result.expiredCount
                totalUnpinned += result.unpinnedCount
            }

            this.stats.lastCheckTimestamp = currentTimestamp
            this.stats.totalExpiredFound += totalExpired
            this.stats.totalUnpinned += totalUnpinned

            if (totalExpired > 0 || totalUnpinned > 0) {
                log.info(
                    `[ExpirationWorker] Check complete: ${totalExpired} expired found, ${totalUnpinned} unpinned`,
                )
            } else if (this.config.verbose) {
                log.debug("[ExpirationWorker] Check complete: no expired pins found")
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error)
            this.stats.lastError = errorMessage
            log.error(`[ExpirationWorker] Check failed: ${errorMessage}`)
        }
    }

    /**
     * Get all accounts that have IPFS state with pins
     * Queries GCRMain for accounts with non-empty pins arrays
     */
    private async getAllAccountsWithIPFS(): Promise<string[]> {
        try {
            const db = await Datasource.getInstance()
            const repo = db.getDataSource().getRepository(GCRMain)

            // Find all accounts with IPFS pins
            // Using QueryBuilder to search for accounts where ipfs.pins is not empty
            const results = await repo
                .createQueryBuilder("gcr")
                .select("gcr.pubkey")
                .where("jsonb_array_length(gcr.ipfs -> 'pins') > 0")
                .getRawMany()

            return results.map((r) => r.gcr_pubkey as string)
        } catch (error) {
            log.error(`[ExpirationWorker] Failed to get accounts with IPFS: ${error}`)
            return []
        }
    }

    /**
     * Process expired pins for a single account
     */
    private async processAccountExpiredPins(
        account: string,
        currentTimestamp: number,
        graceTimestamp: number,
    ): Promise<{ expiredCount: number; unpinnedCount: number }> {
        try {
            // Get account's IPFS state
            const ipfsState = await GCRIPFSRoutines.getIPFSState(account)
            if (!ipfsState || !ipfsState.pins || ipfsState.pins.length === 0) {
                return { expiredCount: 0, unpinnedCount: 0 }
            }

            // Find expired pins
            const expiredPins = getExpiredPins(ipfsState.pins, currentTimestamp)
            if (expiredPins.length === 0) {
                return { expiredCount: 0, unpinnedCount: 0 }
            }

            let unpinnedCount = 0

            // Process expired pins in batches
            const pinsToUnpin = expiredPins.slice(0, this.config.batchSize)

            for (const pin of pinsToUnpin) {
                // Check if pin is past grace period
                const pinExpiredAt = pin.expiresAt || 0
                if (pinExpiredAt < graceTimestamp) {
                    // Pin is past grace period - actually unpin
                    if (this.config.enableUnpin) {
                        const unpinResult = await this.unpinContent(account, pin)
                        if (unpinResult) {
                            unpinnedCount++
                        }
                    }
                }
                // Pins within grace period are just marked as expired but not yet unpinned
            }

            if (this.config.verbose && expiredPins.length > 0) {
                log.debug(
                    `[ExpirationWorker] Account ${account}: ${expiredPins.length} expired, ${unpinnedCount} unpinned`,
                )
            }

            return { expiredCount: expiredPins.length, unpinnedCount }
        } catch (error) {
            log.error(`[ExpirationWorker] Failed to process account ${account}: ${error}`)
            return { expiredCount: 0, unpinnedCount: 0 }
        }
    }

    /**
     * Unpin content from IPFS and update account state
     */
    private async unpinContent(account: string, pin: PinnedContent): Promise<boolean> {
        try {
            // Get IPFS manager
            const ipfs = getIpfsManager()
            if (!ipfs || !ipfs.isInitialized()) {
                log.warning("[ExpirationWorker] IPFS not available for unpin")
                return false
            }

            // Unpin from IPFS
            await ipfs.unpin(pin.cid)

            // Remove from account state
            const removeResult = await GCRIPFSRoutines.removePin(account, pin.cid)
            if (!removeResult.success) {
                log.warning(
                    `[ExpirationWorker] Failed to remove pin state for ${pin.cid}: ${removeResult.message}`,
                )
                return false
            }

            log.info(
                `[ExpirationWorker] Unpinned expired content: CID=${pin.cid}, account=${account}`,
            )
            return true
        } catch (error) {
            log.error(
                `[ExpirationWorker] Failed to unpin ${pin.cid} for account ${account}: ${error}`,
            )
            return false
        }
    }

    /**
     * Manually trigger cleanup of a specific account's expired pins
     * Useful for admin operations
     */
    async forceCleanupAccount(account: string): Promise<{
        success: boolean
        expiredCount: number
        unpinnedCount: number
        message: string
    }> {
        const currentTimestamp = Date.now()
        // For forced cleanup, use immediate expiration (no grace period)
        const graceTimestamp = currentTimestamp

        try {
            const result = await this.processAccountExpiredPins(
                account,
                currentTimestamp,
                graceTimestamp,
            )
            return {
                success: true,
                expiredCount: result.expiredCount,
                unpinnedCount: result.unpinnedCount,
                message: `Processed ${result.expiredCount} expired pins, unpinned ${result.unpinnedCount}`,
            }
        } catch (error) {
            return {
                success: false,
                expiredCount: 0,
                unpinnedCount: 0,
                message: error instanceof Error ? error.message : String(error),
            }
        }
    }
}

// Singleton instance
let workerInstance: ExpirationWorker | null = null

/**
 * Get or create the singleton expiration worker instance
 */
export function getExpirationWorker(config?: Partial<ExpirationWorkerConfig>): ExpirationWorker {
    if (!workerInstance) {
        workerInstance = new ExpirationWorker(config)
    }
    return workerInstance
}

/**
 * Start the expiration worker (convenience function)
 */
export function startExpirationWorker(config?: Partial<ExpirationWorkerConfig>): void {
    const worker = getExpirationWorker(config)
    worker.start()
}

/**
 * Stop the expiration worker (convenience function)
 */
export function stopExpirationWorker(): void {
    if (workerInstance) {
        workerInstance.stop()
    }
}

export default ExpirationWorker
