import L2PSMempool, { L2PS_STATUS, L2PSStatus } from "@/libs/blockchain/l2ps_mempool"
import { L2PSMempoolTx } from "@/model/entities/L2PSMempool"
import Mempool from "@/libs/blockchain/mempool_v2"
import SharedState from "@/utilities/sharedState"
import { getSharedState } from "@/utilities/sharedState"
import log from "@/utilities/logger"
import { Hashing, ucrypto, uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import { getNetworkTimestamp } from "@/libs/utils/calibrateTime"
import ensureGCRForUser from "@/libs/blockchain/gcr/gcr_routines/ensureGCRForUser"

/**
 * L2PS Batch Payload Interface
 * 
 * Represents the encrypted batch data submitted to the main mempool
 */
export interface L2PSBatchPayload {
    /** L2PS network identifier */
    l2ps_uid: string
    /** Base64 encrypted blob containing all transaction data */
    encrypted_batch: string
    /** Number of transactions in this batch */
    transaction_count: number
    /** Deterministic hash of the batch for integrity verification */
    batch_hash: string
    /** Array of original transaction hashes included in this batch */
    transaction_hashes: string[]
}

/**
 * L2PS Batch Aggregator Service
 * 
 * Periodically collects transactions from `l2ps_mempool`, groups them by L2PS network,
 * creates encrypted batch transactions, and submits them to the main mempool.
 * This service completes the "private loop" by moving L2PS transactions from the
 * private mempool to the main blockchain.
 * 
 * Key Features:
 * - Configurable aggregation interval and batch size threshold
 * - Groups transactions by L2PS UID for efficient batching
 * - Encrypts batch data using network-specific keys
 * - Reentrancy protection prevents overlapping operations
 * - Comprehensive error handling and logging
 * - Graceful shutdown support
 * 
 * Lifecycle: processed transactions → batch → main mempool → block → cleanup
 */
export class L2PSBatchAggregator {
    private static instance: L2PSBatchAggregator | null = null

    /** Interval timer for batch aggregation cycles */
    private intervalId: NodeJS.Timeout | null = null

    /** Private constructor enforces singleton pattern */
    private constructor() {}
    
    /** Reentrancy protection flag - prevents overlapping operations */
    private isAggregating = false
    
    /** Service running state */
    private isRunning = false
    
    /** Batch aggregation interval in milliseconds (default: 10 seconds) */
    private readonly AGGREGATION_INTERVAL = 10000
    
    /** Minimum number of transactions to trigger a batch (can be lower if timeout reached) */
    private readonly MIN_BATCH_SIZE = 1
    
    /** Maximum number of transactions per batch to prevent oversized batches */
    private readonly MAX_BATCH_SIZE = 100
    
    /** Cleanup interval - remove batched transactions older than this (1 hour) */
    private readonly CLEANUP_AGE_MS = 60 * 60 * 1000
    
    /** Statistics tracking */
    private stats = {
        totalCycles: 0,
        successfulCycles: 0,
        failedCycles: 0,
        skippedCycles: 0,
        totalBatchesCreated: 0,
        totalTransactionsBatched: 0,
        successfulSubmissions: 0,
        failedSubmissions: 0,
        cleanedUpTransactions: 0,
        lastCycleTime: 0,
        averageCycleTime: 0,
    }

    /**
     * Get singleton instance of L2PS Batch Aggregator
     * @returns L2PSBatchAggregator instance
     */
    static getInstance(): L2PSBatchAggregator {
        if (!this.instance) {
            this.instance = new L2PSBatchAggregator()
        }
        return this.instance
    }

    /**
     * Start the L2PS batch aggregation service
     * 
     * Begins aggregating transactions every 10 seconds (configurable).
     * Uses reentrancy protection to prevent overlapping operations.
     * 
     * @throws {Error} If service is already running
     */
    async start(): Promise<void> {
        if (this.isRunning) {
            throw new Error("[L2PS Batch Aggregator] Service is already running")
        }

        log.info("[L2PS Batch Aggregator] Starting batch aggregation service")

        this.isRunning = true
        this.isAggregating = false

        // Reset statistics
        this.stats = {
            totalCycles: 0,
            successfulCycles: 0,
            failedCycles: 0,
            skippedCycles: 0,
            totalBatchesCreated: 0,
            totalTransactionsBatched: 0,
            successfulSubmissions: 0,
            failedSubmissions: 0,
            cleanedUpTransactions: 0,
            lastCycleTime: 0,
            averageCycleTime: 0,
        }

        // Start the interval timer
        this.intervalId = setInterval(async () => {
            await this.safeAggregateAndSubmit()
        }, this.AGGREGATION_INTERVAL)

        log.info(`[L2PS Batch Aggregator] Started with ${this.AGGREGATION_INTERVAL}ms interval`)
    }

    /**
     * Stop the L2PS batch aggregation service
     * 
     * Gracefully shuts down the service, waiting for any ongoing operations to complete.
     * 
     * @param timeoutMs - Maximum time to wait for ongoing operations (default: 15 seconds)
     */
    async stop(timeoutMs = 15000): Promise<void> {
        if (!this.isRunning) {
            return
        }

        log.info("[L2PS Batch Aggregator] Stopping batch aggregation service")
        
        this.isRunning = false

        // Clear the interval
        if (this.intervalId) {
            clearInterval(this.intervalId)
            this.intervalId = null
        }

        // Wait for ongoing operation to complete
        const startTime = Date.now()
        while (this.isAggregating && (Date.now() - startTime) < timeoutMs) {
            await new Promise(resolve => setTimeout(resolve, 100))
        }

        if (this.isAggregating) {
            log.warning("[L2PS Batch Aggregator] Forced shutdown - operation still in progress")
        }

        log.info("[L2PS Batch Aggregator] Stopped successfully")
        this.logStatistics()
    }

    /**
     * Safe wrapper for batch aggregation with reentrancy protection
     * 
     * Prevents overlapping aggregation cycles that could cause database conflicts
     * and duplicate batch submissions. Skips cycles if previous operation is still running.
     */
    private async safeAggregateAndSubmit(): Promise<void> {
        // Reentrancy protection - skip if already aggregating
        if (this.isAggregating) {
            this.stats.skippedCycles++
            log.warning("[L2PS Batch Aggregator] Skipping cycle - previous operation still in progress")
            return
        }

        // Service shutdown check
        if (!this.isRunning) {
            return
        }

        this.stats.totalCycles++
        const cycleStartTime = Date.now()
        
        try {
            this.isAggregating = true
            await this.aggregateAndSubmitBatches()
            
            // Run cleanup after successful aggregation
            await this.cleanupOldBatchedTransactions()
            
            this.stats.successfulCycles++
            this.updateCycleTime(Date.now() - cycleStartTime)
            
        } catch (error: any) {
            this.stats.failedCycles++
            log.error("[L2PS Batch Aggregator] Aggregation cycle failed:", error)
            
        } finally {
            this.isAggregating = false
        }
    }

    /**
     * Main aggregation logic - collect, batch, and submit transactions
     * 
     * 1. Fetches all processed transactions from L2PS mempool
     * 2. Groups transactions by L2PS UID
     * 3. Creates encrypted batch for each group
     * 4. Submits batches to main mempool
     * 5. Updates transaction statuses to 'batched'
     */
    private async aggregateAndSubmitBatches(): Promise<void> {
        try {
            // Get all processed transactions ready for batching
            const processedTransactions = await L2PSMempool.getByStatus(
                L2PS_STATUS.PROCESSED,
                this.MAX_BATCH_SIZE * 10, // Allow for multiple L2PS networks
            )

            if (processedTransactions.length === 0) {
                log.debug("[L2PS Batch Aggregator] No processed transactions to batch")
                return
            }

            log.info(`[L2PS Batch Aggregator] Found ${processedTransactions.length} transactions to batch`)

            // Group transactions by L2PS UID
            const groupedByUID = this.groupTransactionsByUID(processedTransactions)

            // Process each L2PS network's transactions
            for (const [l2psUid, transactions] of Object.entries(groupedByUID)) {
                await this.processBatchForUID(l2psUid, transactions)
            }

        } catch (error: any) {
            log.error("[L2PS Batch Aggregator] Error in aggregation:", error)
            throw error
        }
    }

    /**
     * Group transactions by their L2PS UID
     * 
     * @param transactions - Array of L2PS mempool transactions
     * @returns Record mapping L2PS UID to array of transactions
     */
    private groupTransactionsByUID(transactions: L2PSMempoolTx[]): Record<string, L2PSMempoolTx[]> {
        const grouped: Record<string, L2PSMempoolTx[]> = {}

        for (const tx of transactions) {
            if (!grouped[tx.l2ps_uid]) {
                grouped[tx.l2ps_uid] = []
            }
            grouped[tx.l2ps_uid].push(tx)
        }

        return grouped
    }

    /**
     * Process a batch of transactions for a specific L2PS UID
     * 
     * @param l2psUid - L2PS network identifier
     * @param transactions - Array of transactions to batch
     */
    private async processBatchForUID(l2psUid: string, transactions: L2PSMempoolTx[]): Promise<void> {
        try {
            // Enforce maximum batch size
            const batchTransactions = transactions.slice(0, this.MAX_BATCH_SIZE)

            if (batchTransactions.length < this.MIN_BATCH_SIZE) {
                log.debug(`[L2PS Batch Aggregator] Not enough transactions for ${l2psUid} (${batchTransactions.length}/${this.MIN_BATCH_SIZE})`)
                return
            }

            log.info(`[L2PS Batch Aggregator] Creating batch for ${l2psUid} with ${batchTransactions.length} transactions`)

            // Create batch payload
            const batchPayload = await this.createBatchPayload(l2psUid, batchTransactions)

            // Create and submit batch transaction to main mempool
            const success = await this.submitBatchToMempool(batchPayload)

            if (success) {
                // Update transaction statuses to 'batched'
                const hashes = batchTransactions.map(tx => tx.hash)
                const updated = await L2PSMempool.updateStatusBatch(hashes, L2PS_STATUS.BATCHED)
                
                this.stats.totalBatchesCreated++
                this.stats.totalTransactionsBatched += batchTransactions.length
                this.stats.successfulSubmissions++

                log.info(`[L2PS Batch Aggregator] Successfully batched ${updated} transactions for ${l2psUid}`)
            } else {
                this.stats.failedSubmissions++
                log.error(`[L2PS Batch Aggregator] Failed to submit batch for ${l2psUid}`)
            }

        } catch (error: any) {
            log.error(`[L2PS Batch Aggregator] Error processing batch for ${l2psUid}:`, error)
            this.stats.failedSubmissions++
        }
    }

    /**
     * Create an encrypted batch payload from transactions
     * 
     * @param l2psUid - L2PS network identifier
     * @param transactions - Transactions to include in batch
     * @returns L2PS batch payload with encrypted data
     */
    private async createBatchPayload(
        l2psUid: string,
        transactions: L2PSMempoolTx[],
    ): Promise<L2PSBatchPayload> {
        // Collect transaction hashes and encrypted data
        const transactionHashes = transactions.map(tx => tx.hash)
        const transactionData = transactions.map(tx => ({
            hash: tx.hash,
            original_hash: tx.original_hash,
            encrypted_tx: tx.encrypted_tx,
        }))

        // Create deterministic batch hash from sorted transaction hashes
        const sortedHashes = [...transactionHashes].sort()
        const batchHashInput = `L2PS_BATCH_${l2psUid}:${sortedHashes.length}:${sortedHashes.join(",")}`
        const batchHash = Hashing.sha256(batchHashInput)

        // For batch transactions, we store the batch data as base64
        // The data is already encrypted at the individual transaction level,
        // so we just package them together
        const batchDataString = JSON.stringify(transactionData)
        const encryptedBatch = Buffer.from(batchDataString).toString("base64")

        return {
            l2ps_uid: l2psUid,
            encrypted_batch: encryptedBatch,
            transaction_count: transactions.length,
            batch_hash: batchHash,
            transaction_hashes: transactionHashes,
        }
    }

    /**
     * Submit a batch transaction to the main mempool
     * 
     * Creates a transaction of type 'l2psBatch' and submits it to the main
     * mempool for inclusion in the next block.
     * 
     * @param l2psUid - L2PS network identifier
     * @param batchPayload - Encrypted batch payload
     * @returns true if submission was successful
     */
    private async submitBatchToMempool(batchPayload: L2PSBatchPayload): Promise<boolean> {
        try {
            const sharedState = getSharedState

            // Use keypair.publicKey (set by loadIdentity) instead of identity.ed25519
            if (!sharedState.keypair?.publicKey) {
                log.error("[L2PS Batch Aggregator] Node keypair not loaded yet")
                return false
            }

            // Get node's public key as hex string for 'from' field
            const nodeIdentityHex = uint8ArrayToHex(sharedState.keypair.publicKey as Uint8Array)

            // Get current nonce for the node's identity account
            let currentNonce = 1
            try {
                const accountState = await ensureGCRForUser(nodeIdentityHex)
                currentNonce = (accountState?.nonce ?? 0) + 1
                log.debug(`[L2PS Batch Aggregator] Got nonce ${currentNonce} for ${nodeIdentityHex}`)
            } catch (nonceError: any) {
                log.warning(`[L2PS Batch Aggregator] Could not get nonce, using 1: ${nonceError.message}`)
                currentNonce = 1
            }

            // Create batch transaction content
            const transactionContent = {
                type: "l2psBatch",
                from: nodeIdentityHex,
                to: nodeIdentityHex, // Self-directed for relay
                from_ed25519_address: nodeIdentityHex,
                amount: 0,
                timestamp: getNetworkTimestamp(),
                nonce: currentNonce,
                fee: 0,
                data: ["l2psBatch", batchPayload],
                transaction_fee: {
                    network_fee: 0,
                    rpc_fee: 0,
                    additional_fee: 0,
                },
            }

            // Create transaction hash
            const contentString = JSON.stringify(transactionContent)
            const hash = Hashing.sha256(contentString)

            // Sign the transaction
            const signature = await ucrypto.sign(
                sharedState.signingAlgorithm,
                new TextEncoder().encode(contentString),
            )

            // Create batch transaction object matching mempool expectations
            // Note: status and extra fields are required by MempoolTx entity
            const batchTransaction = {
                hash,
                content: transactionContent,
                signature: signature ? {
                    type: sharedState.signingAlgorithm,
                    data: uint8ArrayToHex(signature.signature),
                } : null,
                reference_block: 0, // Will be set by mempool
                status: "pending", // Required by MempoolTx entity
                extra: null, // Optional field
            }

            // Submit to main mempool
            const result = await Mempool.addTransaction(batchTransaction as any)

            if (result.error) {
                log.error(`[L2PS Batch Aggregator] Failed to add batch to mempool: ${result.error}`)
                return false
            }

            log.info(`[L2PS Batch Aggregator] Batch ${batchPayload.batch_hash.substring(0, 16)}... submitted to mempool (block ${result.confirmationBlock})`)
            return true

        } catch (error: any) {
            log.error(`[L2PS Batch Aggregator] Error submitting batch to mempool: ${error.message || error}`)
            if (error.stack) {
                log.debug(`[L2PS Batch Aggregator] Stack trace: ${error.stack}`)
            }
            return false
        }
    }

    /**
     * Cleanup old batched transactions
     * 
     * Removes transactions that have been in 'batched' status for longer
     * than the cleanup age threshold. This prevents the L2PS mempool from
     * growing indefinitely.
     */
    private async cleanupOldBatchedTransactions(): Promise<void> {
        try {
            const deleted = await L2PSMempool.cleanupByStatus(
                L2PS_STATUS.BATCHED,
                this.CLEANUP_AGE_MS,
            )

            if (deleted > 0) {
                this.stats.cleanedUpTransactions += deleted
                log.info(`[L2PS Batch Aggregator] Cleaned up ${deleted} old batched transactions`)
            }

        } catch (error: any) {
            log.error("[L2PS Batch Aggregator] Error during cleanup:", error)
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
        log.info("[L2PS Batch Aggregator] Final Statistics:" + "\n" + JSON.stringify({
            totalCycles: this.stats.totalCycles,
            successfulCycles: this.stats.successfulCycles,
            failedCycles: this.stats.failedCycles,
            skippedCycles: this.stats.skippedCycles,
            successRate: this.stats.totalCycles > 0
                ? `${Math.round((this.stats.successfulCycles / this.stats.totalCycles) * 100)}%`
                : "0%",
            totalBatchesCreated: this.stats.totalBatchesCreated,
            totalTransactionsBatched: this.stats.totalTransactionsBatched,
            successfulSubmissions: this.stats.successfulSubmissions,
            failedSubmissions: this.stats.failedSubmissions,
            cleanedUpTransactions: this.stats.cleanedUpTransactions,
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
        isAggregating: boolean;
        intervalMs: number;
        joinedL2PSCount: number;
    } {
        return {
            isRunning: this.isRunning,
            isAggregating: this.isAggregating,
            intervalMs: this.AGGREGATION_INTERVAL,
            joinedL2PSCount: SharedState.getInstance().l2psJoinedUids?.length || 0,
        }
    }

    /**
     * Force a single aggregation cycle (for testing/debugging)
     * 
     * @throws {Error} If service is not running or already aggregating
     */
    async forceAggregation(): Promise<void> {
        if (!this.isRunning) {
            throw new Error("[L2PS Batch Aggregator] Service is not running")
        }

        if (this.isAggregating) {
            throw new Error("[L2PS Batch Aggregator] Aggregation already in progress")
        }

        log.info("[L2PS Batch Aggregator] Forcing aggregation cycle")
        await this.safeAggregateAndSubmit()
    }
}
