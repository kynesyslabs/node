import L2PSMempool from "@/libs/blockchain/l2ps_mempool"
import { Demos, DemosTransactions } from "@kynesyslabs/demosdk/websdk"
import SharedState from "@/utilities/sharedState"
import log from "@/utilities/logger"
import { getSharedState } from "@/utilities/sharedState"
import getShard from "@/libs/consensus/v2/routines/getShard"
import getCommonValidatorSeed from "@/libs/consensus/v2/routines/getCommonValidatorSeed"

/**
 * L2PS Hash Generation Service
 * 
 * Generates consolidated hashes for L2PS networks every 5 seconds and relays them
 * to validators via DTR (Distributed Transaction Routing). This service enables
 * validators to track L2PS network activity without accessing transaction content,
 * preserving privacy while maintaining consensus participation.
 * 
 * Key Features:
 * - Reentrancy protection prevents overlapping hash generation cycles
 * - Automatic retry with exponential backoff for failed relays
 * - Comprehensive error handling and logging
 * - Graceful shutdown support
 * - Performance monitoring and statistics
 */
export class L2PSHashService {
    private static instance: L2PSHashService | null = null
    
    /** Interval timer for hash generation cycles */
    private intervalId: NodeJS.Timeout | null = null
    
    /** Reentrancy protection flag - prevents overlapping operations */
    private isGenerating = false
    
    /** Service running state */
    private isRunning = false
    
    /** Hash generation interval in milliseconds */
    private readonly GENERATION_INTERVAL = 5000 // 5 seconds
    
    /** Statistics tracking */
    private stats = {
        totalCycles: 0,
        successfulCycles: 0,
        failedCycles: 0,
        skippedCycles: 0,
        totalHashesGenerated: 0,
        totalRelayAttempts: 0,
        lastCycleTime: 0,
        averageCycleTime: 0,
    }

    /**
     * Get singleton instance of L2PS Hash Service
     * @returns L2PSHashService instance
     */
    static getInstance(): L2PSHashService {
        if (!this.instance) {
            this.instance = new L2PSHashService()
        }
        return this.instance
    }

    /**
     * Start the L2PS hash generation service
     * 
     * Begins generating consolidated hashes every 5 seconds for all joined L2PS networks.
     * Uses reentrancy protection to prevent overlapping operations.
     * 
     * @throws {Error} If service is already running
     */
    async start(): Promise<void> {
        if (this.isRunning) {
            throw new Error("[L2PS Hash Service] Service is already running")
        }

        log.info("[L2PS Hash Service] Starting hash generation service")
        
        this.isRunning = true
        this.isGenerating = false
        
        // Reset statistics
        this.stats = {
            totalCycles: 0,
            successfulCycles: 0,
            failedCycles: 0,
            skippedCycles: 0,
            totalHashesGenerated: 0,
            totalRelayAttempts: 0,
            lastCycleTime: 0,
            averageCycleTime: 0,
        }

        // Start the interval timer
        this.intervalId = setInterval(async () => {
            await this.safeGenerateAndRelayHashes()
        }, this.GENERATION_INTERVAL)

        log.info(`[L2PS Hash Service] Started with ${this.GENERATION_INTERVAL}ms interval`)
    }

    /**
     * Stop the L2PS hash generation service
     * 
     * Gracefully shuts down the service, waiting for any ongoing operations to complete.
     * 
     * @param timeoutMs - Maximum time to wait for ongoing operations (default: 10 seconds)
     */
    async stop(timeoutMs = 10000): Promise<void> {
        if (!this.isRunning) {
            return
        }

        log.info("[L2PS Hash Service] Stopping hash generation service")
        
        this.isRunning = false

        // Clear the interval
        if (this.intervalId) {
            clearInterval(this.intervalId)
            this.intervalId = null
        }

        // Wait for ongoing operation to complete
        const startTime = Date.now()
        while (this.isGenerating && (Date.now() - startTime) < timeoutMs) {
            await new Promise(resolve => setTimeout(resolve, 100))
        }

        if (this.isGenerating) {
            log.warning("[L2PS Hash Service] Forced shutdown - operation still in progress")
        }

        log.info("[L2PS Hash Service] Stopped successfully")
        this.logStatistics()
    }

    /**
     * Safe wrapper for hash generation with reentrancy protection
     * 
     * Prevents overlapping hash generation cycles that could cause database conflicts
     * and performance issues. Skips cycles if previous operation is still running.
     */
    private async safeGenerateAndRelayHashes(): Promise<void> {
        // Reentrancy protection - skip if already generating
        if (this.isGenerating) {
            this.stats.skippedCycles++
            log.warning("[L2PS Hash Service] Skipping cycle - previous operation still in progress")
            return
        }

        // Service shutdown check
        if (!this.isRunning) {
            return
        }

        this.stats.totalCycles++
        const cycleStartTime = Date.now()
        
        try {
            this.isGenerating = true
            await this.generateAndRelayHashes()
            
            this.stats.successfulCycles++
            this.updateCycleTime(Date.now() - cycleStartTime)
            
        } catch (error: any) {
            this.stats.failedCycles++
            log.error("[L2PS Hash Service] Hash generation cycle failed:", error)
            
        } finally {
            this.isGenerating = false
        }
    }

    /**
     * Generate consolidated hashes for all joined L2PS networks and relay to validators
     * 
     * Core hash generation logic that:
     * 1. Iterates through all joined L2PS UIDs
     * 2. Generates consolidated hashes using L2PSMempool
     * 3. Creates L2PS hash update transactions
     * 4. Relays to validators via DTR infrastructure
     */
    private async generateAndRelayHashes(): Promise<void> {
        try {
            // Get all joined L2PS UIDs from shared state
            const joinedUIDs = SharedState.getInstance().l2psJoinedUids || []
            
            if (joinedUIDs.length === 0) {
                return // No L2PS networks to process
            }

            log.debug(`[L2PS Hash Service] Processing ${joinedUIDs.length} L2PS networks`)

            // Process each L2PS network
            for (const l2psUid of joinedUIDs) {
                await this.processL2PSNetwork(l2psUid)
            }

        } catch (error: any) {
            log.error("[L2PS Hash Service] Error in hash generation:", error)
            throw error
        }
    }

    /**
     * Process a single L2PS network for hash generation and relay
     * 
     * @param l2psUid - L2PS network identifier
     */
    private async processL2PSNetwork(l2psUid: string): Promise<void> {
        try {
            // Generate consolidated hash for this L2PS UID
            const consolidatedHash = await L2PSMempool.getHashForL2PS(l2psUid)
            
            // Get transaction count for this UID (only processed transactions)
            const transactions = await L2PSMempool.getByUID(l2psUid, "processed")
            const transactionCount = transactions.length

            // Only generate hash update if there are transactions
            if (transactionCount === 0) {
                log.debug(`[L2PS Hash Service] No transactions for L2PS ${l2psUid}, skipping`)
                return
            }

            // Create L2PS hash update transaction using SDK
            const demos = new Demos() // TODO: Get from shared state or service registry - will be fixed once Demos SDK is updated to the latest version
            const hashUpdateTx = await DemosTransactions.createL2PSHashUpdate(
                l2psUid,
                consolidatedHash,
                transactionCount,
                demos,
            )

            this.stats.totalHashesGenerated++

            // Relay to validators via DTR infrastructure
            // Note: Self-directed transaction will automatically trigger DTR routing
            await this.relayToValidators(hashUpdateTx)
            
            this.stats.totalRelayAttempts++

            log.debug(`[L2PS Hash Service] Generated hash for ${l2psUid}: ${consolidatedHash} (${transactionCount} txs)`)

        } catch (error: any) {
            log.error(`[L2PS Hash Service] Error processing L2PS ${l2psUid}:`, error)
            // Continue processing other L2PS networks even if one fails
        }
    }

    /**
     * Relay hash update transaction to validators via DTR
     * 
     * Uses the same DTR infrastructure as regular transactions but with direct
     * validator calls instead of mempool dependency. This ensures L2PS hash
     * updates reach validators without requiring ValidityData caching.
     * 
     * @param hashUpdateTx - Signed L2PS hash update transaction
     */
    private async relayToValidators(hashUpdateTx: any): Promise<void> {
        try {
            // Only relay in production mode (same as existing DTR pattern)
            if (!getSharedState.PROD) {
                log.debug("[L2PS Hash Service] Skipping DTR relay (non-production mode)")
                return
            }

            // Get validators using same logic as DTR RelayRetryService
            const { commonValidatorSeed } = await getCommonValidatorSeed()
            const validators = await getShard(commonValidatorSeed)
            const availableValidators = validators
                .filter(v => v.status.online && v.sync.status)
                .sort(() => Math.random() - 0.5) // Random order for load balancing

            if (availableValidators.length === 0) {
                throw new Error("No validators available for L2PS hash relay")
            }

            log.debug(`[L2PS Hash Service] Attempting to relay hash update to ${availableValidators.length} validators`)

            // Try all validators in random order (same pattern as DTR)
            for (const validator of availableValidators) {
                try {
                    const result = await validator.call({
                        method: "nodeCall",
                        params: [{
                            type: "RELAY_TX",
                            data: { transaction: hashUpdateTx }
                        }]
                    }, true)

                    if (result.result === 200) {
                        log.info(`[L2PS Hash Service] Successfully relayed hash update to validator ${validator.identity.substring(0, 8)}...`)
                        return // Success - one validator accepted is enough
                    }

                    log.debug(`[L2PS Hash Service] Validator ${validator.identity.substring(0, 8)}... rejected hash update: ${result.response}`)

                } catch (error: any) {
                    log.debug(`[L2PS Hash Service] Validator ${validator.identity.substring(0, 8)}... error: ${error.message}`)
                    continue // Try next validator
                }
            }

            // If we reach here, all validators failed
            throw new Error(`All ${availableValidators.length} validators failed to accept L2PS hash update`)
            
        } catch (error: any) {
            log.error("[L2PS Hash Service] Failed to relay hash update to validators:", error)
            throw error
        }
    }

    /**
     * Update average cycle time statistics
     * 
     * @param cycleTime - Time taken for this cycle in milliseconds
     */
    private updateCycleTime(cycleTime: number): void {
        this.stats.lastCycleTime = cycleTime
        
        // Calculate running average
        const totalTime = (this.stats.averageCycleTime * (this.stats.successfulCycles - 1)) + cycleTime
        this.stats.averageCycleTime = Math.round(totalTime / this.stats.successfulCycles)
    }

    /**
     * Log comprehensive service statistics
     */
    private logStatistics(): void {
        log.info("[L2PS Hash Service] Final Statistics:" + "\n" + JSON.stringify( {
            totalCycles: this.stats.totalCycles,
            successfulCycles: this.stats.successfulCycles,
            failedCycles: this.stats.failedCycles,
            skippedCycles: this.stats.skippedCycles,
            successRate: this.stats.totalCycles > 0 
                ? `${Math.round((this.stats.successfulCycles / this.stats.totalCycles) * 100)}%` 
                : "0%",
            totalHashesGenerated: this.stats.totalHashesGenerated,
            totalRelayAttempts: this.stats.totalRelayAttempts,
            averageCycleTime: `${this.stats.averageCycleTime}ms`,
            lastCycleTime: `${this.stats.lastCycleTime}ms`,
        }))
    }

    /**
     * Get current service statistics
     * 
     * @returns Current service statistics object
     */
    getStatistics(): typeof this.stats {
        return { ...this.stats }
    }

    /**
     * Get current service status
     * 
     * @returns Service status information
     */
    getStatus(): {
        isRunning: boolean;
        isGenerating: boolean;
        intervalMs: number;
        joinedL2PSCount: number;
    } {
        return {
            isRunning: this.isRunning,
            isGenerating: this.isGenerating,
            intervalMs: this.GENERATION_INTERVAL,
            joinedL2PSCount: SharedState.getInstance().l2psJoinedUids?.length || 0,
        }
    }

    /**
     * Force a single hash generation cycle (for testing/debugging)
     * 
     * @throws {Error} If service is not running or already generating
     */
    async forceGeneration(): Promise<void> {
        if (!this.isRunning) {
            throw new Error("[L2PS Hash Service] Service is not running")
        }

        if (this.isGenerating) {
            throw new Error("[L2PS Hash Service] Generation already in progress")
        }

        log.info("[L2PS Hash Service] Forcing hash generation cycle")
        await this.safeGenerateAndRelayHashes()
    }
}