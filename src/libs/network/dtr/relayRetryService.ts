import Mempool from "../../blockchain/mempool_v2"
import isValidatorForNextBlock from "../../consensus/v2/routines/isValidator"
import getShard from "../../consensus/v2/routines/getShard"
import getCommonValidatorSeed from "../../consensus/v2/routines/getCommonValidatorSeed"
import { getSharedState } from "../../../utilities/sharedState"
import log from "../../../utilities/logger"

/**
 * DTR (Distributed Transaction Routing) Relay Retry Service
 * 
 * Background service that continuously attempts to relay transactions from non-validator nodes
 * to validator nodes. Runs every 10 seconds on non-validator nodes in production mode.
 * 
 * Key Features:
 * - Only runs on non-validator nodes when PROD=true
 * - Recalculates validator set only when block number changes (optimized)
 * - Tries all validators in random order for load balancing
 * - Removes successfully relayed transactions from local mempool
 * - Gives up after 10 failed attempts per transaction
 * - Manages ValidityData cache cleanup
 */
export class RelayRetryService {
    private static instance: RelayRetryService
    private isRunning = false
    private retryInterval: NodeJS.Timeout | null = null
    private retryAttempts = new Map<string, number>() // txHash -> attempt count
    private readonly maxRetryAttempts = 10
    private readonly retryIntervalMs = 10000 // 10 seconds
    
    // Optimization: only recalculate validators when block number changes
    private lastBlockNumber = 0
    private cachedValidators: any[] = []
    
    static getInstance(): RelayRetryService {
        if (!RelayRetryService.instance) {
            RelayRetryService.instance = new RelayRetryService()
        }
        return RelayRetryService.instance
    }
    
    /**
     * Starts the background relay retry service
     * Only starts if not already running
     */
    start() {
        if (this.isRunning) return
        
        console.log("[DTR RetryService] Starting background relay service")
        log.info("[DTR RetryService] Service started - will retry every 10 seconds")
        this.isRunning = true
        
        this.retryInterval = setInterval(() => {
            this.processMempool().catch(error => {
                log.error("[DTR RetryService] Error in retry cycle: " + error)
            })
        }, this.retryIntervalMs)
    }
    
    /**
     * Stops the background relay retry service
     * Cleans up interval and resets state
     */
    stop() {
        if (!this.isRunning) return
        
        console.log("[DTR RetryService] Stopping relay service")
        log.info("[DTR RetryService] Service stopped")
        this.isRunning = false
        
        if (this.retryInterval) {
            clearInterval(this.retryInterval)
            this.retryInterval = null
        }
        
        // Clean up state
        this.retryAttempts.clear()
        this.cachedValidators = []
        this.lastBlockNumber = 0
    }
    
    /**
     * Main processing loop - runs every 10 seconds
     * Checks mempool for transactions that need relaying
     */
    private async processMempool() {
        try {
            // Only run in production mode
            if (!getSharedState.PROD) {
                return
            }
            
            // Only run after sync is complete
            if (!getSharedState.syncStatus) {
                return
            }
            
            // Only run on non-validator nodes
            if (await isValidatorForNextBlock()) {
                return
            }
            
            // Get our entire mempool
            const mempool = await Mempool.getMempool()
            
            if (mempool.length === 0) {
                return
            }
            
            console.log(`[DTR RetryService] Processing ${mempool.length} transactions in mempool`)
            
            // Get validators (only recalculate if block number changed)
            const availableValidators = await this.getValidatorsOptimized()
            
            if (availableValidators.length === 0) {
                console.log("[DTR RetryService] No validators available for relay")
                return
            }
            
            console.log(`[DTR RetryService] Found ${availableValidators.length} available validators`)
            
            // Process each transaction in mempool
            for (const tx of mempool) {
                await this.tryRelayTransaction(tx, availableValidators)
            }
            
        } catch (error) {
            log.error("[DTR RetryService] Error processing mempool: " + error)
        }
    }
    
    /**
     * Optimized validator retrieval - only recalculates when block number changes
     * @returns Array of available validators in random order
     */
    private async getValidatorsOptimized(): Promise<any[]> {
        const currentBlockNumber = getSharedState.lastBlockNumber
        
        // Only recalculate if block number changed
        if (currentBlockNumber !== this.lastBlockNumber || this.cachedValidators.length === 0) {
            console.log(`[DTR RetryService] Block number changed (${this.lastBlockNumber} -> ${currentBlockNumber}), recalculating validators`)
            
            try {
                const { commonValidatorSeed } = await getCommonValidatorSeed()
                const validators = await getShard(commonValidatorSeed)
                
                // Filter and cache validators
                this.cachedValidators = validators.filter(v => v.status.online && v.sync.status)
                this.lastBlockNumber = currentBlockNumber
                
                console.log(`[DTR RetryService] Cached ${this.cachedValidators.length} validators for block ${currentBlockNumber}`)
            } catch (error) {
                log.error("[DTR RetryService] Error recalculating validators: " + error)
                return []
            }
        }
        
        // Return validators in random order for load balancing
        return [...this.cachedValidators].sort(() => Math.random() - 0.5)
    }
    
    /**
     * Attempts to relay a single transaction to all available validators
     * @param transaction - Transaction to relay
     * @param validators - Array of available validators
     */
    private async tryRelayTransaction(transaction: any, validators: any[]): Promise<void> {
        const txHash = transaction.hash
        const currentAttempts = this.retryAttempts.get(txHash) || 0
        
        // Give up after max attempts
        if (currentAttempts >= this.maxRetryAttempts) {
            console.log(`[DTR RetryService] Giving up on transaction ${txHash} after ${this.maxRetryAttempts} attempts`)
            log.warning(`[DTR RetryService] Transaction ${txHash} abandoned after ${this.maxRetryAttempts} failed relay attempts`)
            this.retryAttempts.delete(txHash)
            // Clean up ValidityData from memory
            getSharedState.validityDataCache.delete(txHash)
            return
        }
        
        // Check if we have ValidityData in memory
        const validityData = getSharedState.validityDataCache.get(txHash)
        if (!validityData) {
            console.log(`[DTR RetryService] No ValidityData found for ${txHash}, removing from mempool`)
            log.error(`[DTR RetryService] Missing ValidityData for transaction ${txHash} - removing from mempool`)
            await Mempool.removeTransaction(txHash)
            this.retryAttempts.delete(txHash)
            return
        }
        
        // Try all validators in random order
        for (const validator of validators) {
            try {
                const result = await validator.call({
                    method: "nodeCall",
                    params: [{
                        type: "RELAY_TX",
                        data: { 
                            transaction,
                            validityData: validityData,
                        },
                    }],
                }, true)
                
                if (result.result === 200) {
                    console.log(`[DTR RetryService] Successfully relayed ${txHash} to validator ${validator.identity.substring(0, 8)}...`)
                    log.info(`[DTR RetryService] Transaction ${txHash} successfully relayed after ${currentAttempts + 1} attempts`)
                    
                    // Remove from local mempool since it's now in validator's mempool
                    await Mempool.removeTransaction(txHash)
                    this.retryAttempts.delete(txHash)
                    getSharedState.validityDataCache.delete(txHash)
                    return // Success!
                }
                
                console.log(`[DTR RetryService] Validator ${validator.identity.substring(0, 8)}... rejected ${txHash}: ${result.response}`)
                
            } catch (error: any) {
                console.log(`[DTR RetryService] Validator ${validator.identity.substring(0, 8)}... error for ${txHash}: ${error.message}`)
                continue // Try next validator
            }
        }
        
        // All validators failed, increment attempt count
        this.retryAttempts.set(txHash, currentAttempts + 1)
        console.log(`[DTR RetryService] Attempt ${currentAttempts + 1}/${this.maxRetryAttempts} failed for ${txHash}`)
    }
    
    /**
     * Returns service statistics for monitoring
     * @returns Object with service stats
     */
    getStats() {
        return {
            isRunning: this.isRunning,
            pendingRetries: this.retryAttempts.size,
            cacheSize: getSharedState.validityDataCache.size,
            retryAttempts: Object.fromEntries(this.retryAttempts),
            lastBlockNumber: this.lastBlockNumber,
            cachedValidators: this.cachedValidators.length,
        }
    }
}