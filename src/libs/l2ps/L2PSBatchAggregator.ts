import L2PSMempool, { L2PS_STATUS } from "@/libs/blockchain/l2ps_mempool"
import { L2PSMempoolTx } from "@/model/entities/L2PSMempool"
import Mempool from "@/libs/blockchain/mempool"
import { getSharedState } from "@/utilities/sharedState"
import log from "@/utilities/logger"
import { getErrorMessage } from "@/utilities/errorMessage"
import { Hashing, ucrypto, uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import { getNetworkTimestamp } from "@/libs/utils/calibrateTime"
import crypto from "crypto"
import { L2PSBatchProver } from "@/libs/l2ps/zk/L2PSBatchProver"
import L2PSProofManager from "./L2PSProofManager"
import type { GCREdit } from "@kynesyslabs/demosdk/types"
import { Config } from "src/config"
import type { L2PSBatchPayload } from "./types"
import { ZK_CIRCUIT_MAX_BATCH_SIZE, BATCH_SIGNATURE_DOMAIN } from "./constants"
import TxValidatorPool from "../blockchain/validation/txValidatorPool"

// Re-export for backward compatibility
export type { L2PSBatchPayload } from "./types"

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
    private constructor() { }

    /** Reentrancy protection flag - prevents overlapping operations */
    private isAggregating = false

    /** Service running state */
    private isRunning = false

    /** ZK Batch Prover for generating PLONK proofs */
    private zkProver: L2PSBatchProver | null = null

    /** Whether ZK proofs are enabled (requires setup_all_batches.sh to be run first) */
    private zkEnabled = Config.getInstance().l2ps.zkEnabled

    /** Batch aggregation interval in milliseconds */
    private readonly AGGREGATION_INTERVAL = Config.getInstance().l2ps.aggregationIntervalMs

    /** Minimum number of transactions to trigger a batch (can be lower if timeout reached) */
    private readonly MIN_BATCH_SIZE = Config.getInstance().l2ps.minBatchSize

    /** Maximum number of transactions per batch (limited by ZK circuit size) */
    private readonly MAX_BATCH_SIZE = Math.min(
        Config.getInstance().l2ps.maxBatchSize,
        ZK_CIRCUIT_MAX_BATCH_SIZE,
    )

    /** Cleanup age - remove batched transactions older than this (ms) */
    private readonly CLEANUP_AGE_MS = Config.getInstance().l2ps.cleanupAgeMs

    /** Domain separator for batch transaction signatures */
    private readonly SIGNATURE_DOMAIN = BATCH_SIGNATURE_DOMAIN

    /** Statistics tracking */
    private stats = this.createInitialStats()

    /**
     * Create initial statistics object
     * Helper to avoid code duplication when resetting stats
     */
    private createInitialStats() {
        return {
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

        // Initialize ZK Prover (optional - gracefully degrades if keys not available)
        await this.initializeZkProver()

        // Reset statistics using helper method
        this.stats = this.createInitialStats()

        // Start the interval timer
        this.intervalId = setInterval(async () => {
            await this.safeAggregateAndSubmit()
        }, this.AGGREGATION_INTERVAL)

        log.info(`[L2PS Batch Aggregator] Started with ${this.AGGREGATION_INTERVAL}ms interval`)
    }

    /**
     * Initialize ZK Prover for batch proof generation
     * Gracefully degrades if ZK keys are not available
     */
    private async initializeZkProver(): Promise<void> {
        try {
            this.zkProver = new L2PSBatchProver()
            await this.zkProver.initialize()
            this.zkEnabled = true
            log.info("[L2PS Batch Aggregator] ZK Prover initialized successfully")
        } catch (error) {
            this.zkEnabled = false
            this.zkProver = null
            const errorMessage = getErrorMessage(error)
            log.warning(`[L2PS Batch Aggregator] ZK Prover not available: ${errorMessage}`)
            log.warning("[L2PS Batch Aggregator] Batches will be submitted without ZK proofs")
            log.warning("[L2PS Batch Aggregator] Run 'src/libs/l2ps/zk/scripts/setup_all_batches.sh' to enable ZK proofs")
        }
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

        } catch (error) {
            this.stats.failedCycles++
            const message = getErrorMessage(error)
            log.error(`[L2PS Batch Aggregator] Aggregation cycle failed: ${message}`)

        } finally {
            this.isAggregating = false
        }
    }

    /**
     * Main aggregation logic - collect, batch, and submit transactions
     * 
     * 1. Fetches all executed transactions from L2PS mempool
     * 2. Groups transactions by L2PS UID
     * 3. Creates encrypted batch for each group
     * 4. Submits batches to main mempool
     * 5. Updates transaction statuses to 'batched'
     */
    private async aggregateAndSubmitBatches(): Promise<void> {
        try {
            // Get all executed transactions ready for batching
            const executedTransactions = await L2PSMempool.getByStatus(
                L2PS_STATUS.EXECUTED,
                this.MAX_BATCH_SIZE * 10, // Allow for multiple L2PS networks
            )

            if (executedTransactions.length === 0) {
                log.debug("[L2PS Batch Aggregator] No executed transactions to batch")
                return
            }

            log.info(`[L2PS Batch Aggregator] Found ${executedTransactions.length} transactions to batch`)

            // Group transactions by L2PS UID
            const groupedByUID = this.groupTransactionsByUID(executedTransactions)

            // Process each L2PS network's transactions
            for (const [l2psUid, transactions] of Object.entries(groupedByUID)) {
                await this.processBatchForUID(l2psUid, transactions)
            }

        } catch (error) {
            const message = getErrorMessage(error)
            log.error(`[L2PS Batch Aggregator] Error in aggregation: ${message}`)
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

            // Aggregate GCR edits from all transactions in this batch
            const { aggregatedEdits, totalAffectedAccountsCount } = this.aggregateGCREdits(batchTransactions)

            // Create and submit batch transaction to main mempool
            const success = await this.submitBatchToMempool(batchPayload)

            if (success) {
                // Create a SINGLE aggregated proof for the entire batch
                if (aggregatedEdits.length > 0) {
                    const transactionHashes = batchTransactions.map(tx => tx.hash)
                    const proofResult = await L2PSProofManager.createProof(
                        l2psUid,
                        batchPayload.batch_hash,
                        aggregatedEdits,
                        totalAffectedAccountsCount,
                        batchTransactions.length,
                        transactionHashes
                    )

                    if (proofResult.success) {
                        log.info(`[L2PS Batch Aggregator] Created aggregated proof ${proofResult.proof_id} for ${batchTransactions.length} transactions with ${aggregatedEdits.length} GCR edits`)
                    } else {
                        log.error(`[L2PS Batch Aggregator] Failed to create aggregated proof: ${proofResult.message}`)
                    }
                }

                // Update transaction statuses in l2ps_mempool
                const hashes = batchTransactions.map(tx => tx.hash)
                const updated = await L2PSMempool.updateStatusBatch(hashes, L2PS_STATUS.BATCHED)

                // Update transaction statuses in l2ps_transactions table (history)
                const L2PSTransactionExecutor = (await import("./L2PSTransactionExecutor")).default
                for (const txHash of hashes) {
                    try {
                        await L2PSTransactionExecutor.updateTransactionStatus(
                            txHash,
                            "batched",
                            undefined,
                            `Included in unconfirmed L1 batch`
                        )
                    } catch (err) {
                        log.warning(`[L2PS Batch Aggregator] Failed to update tx status for ${txHash.slice(0, 16)}...`)
                    }
                }

                this.stats.totalBatchesCreated++
                this.stats.totalTransactionsBatched += batchTransactions.length
                this.stats.successfulSubmissions++

                log.info(`[L2PS Batch Aggregator] Successfully batched ${updated} transactions for ${l2psUid}`)
            } else {
                this.stats.failedSubmissions++
                log.error(`[L2PS Batch Aggregator] Failed to submit batch for ${l2psUid}`)
            }

        } catch (error) {
            const message = getErrorMessage(error)
            log.error(`[L2PS Batch Aggregator] Error processing batch for ${l2psUid}: ${message}`)
            this.stats.failedSubmissions++
        }
    }

    /**
     * Aggregate GCR edits from all transactions in a batch
     *
     * @param transactions - Array of transactions to aggregate edits from
     * @returns Object containing aggregated edits and all affected accounts
     */
    private aggregateGCREdits(transactions: L2PSMempoolTx[]): {
        aggregatedEdits: GCREdit[]
        totalAffectedAccountsCount: number
    } {
        const aggregatedEdits: GCREdit[] = []
        let totalAffectedAccountsCount = 0

        for (const tx of transactions) {
            // Get GCR edits from transaction (stored during execution)
            if (tx.gcr_edits && Array.isArray(tx.gcr_edits)) {
                aggregatedEdits.push(...tx.gcr_edits)
            }

            // Sum affected accounts counts (privacy-preserving)
            if (tx.affected_accounts_count && typeof tx.affected_accounts_count === 'number') {
                totalAffectedAccountsCount += tx.affected_accounts_count
            }
        }

        log.debug(`[L2PS Batch Aggregator] Aggregated ${aggregatedEdits.length} GCR edits from ${transactions.length} transactions`)

        return {
            aggregatedEdits,
            totalAffectedAccountsCount
        }
    }

    /**
     * Create an encrypted batch payload from transactions
     * 
     * Uses HMAC-SHA256 for authenticated encryption to prevent tampering.
     * Optionally includes ZK-SNARK proof if prover is available.
     * 
     * @param l2psUid - L2PS network identifier
     * @param transactions - Transactions to include in batch
     * @returns L2PS batch payload with encrypted data and authentication tag
     */
    private async createBatchPayload(
        l2psUid: string,
        transactions: L2PSMempoolTx[],
    ): Promise<L2PSBatchPayload> {
        const sharedState = getSharedState

        // Collect transaction hashes and encrypted data
        const transactionHashes = transactions.map(tx => tx.hash)
        const transactionData = transactions.map(tx => ({
            hash: tx.hash,
            original_hash: tx.original_hash,
            encrypted_tx: tx.encrypted_tx,
        }))

        // Create deterministic batch hash from sorted transaction hashes
        const sortedHashes = [...transactionHashes].sort((a, b) => a.localeCompare(b))
        const batchHashInput = `L2PS_BATCH_${l2psUid}:${sortedHashes.length}:${sortedHashes.join(",")}`
        const batchHash = Hashing.sha256(batchHashInput)

        // For batch transactions, we store the batch data as base64
        // The data is already encrypted at the individual transaction level,
        // so we just package them together
        const batchDataString = JSON.stringify(transactionData)
        const encryptedBatch = Buffer.from(batchDataString).toString("base64")

        // Create HMAC-SHA256 authentication tag for tamper detection
        // Uses node's private key as HMAC key for authenticated encryption
        if (!sharedState.keypair?.privateKey) {
            throw new Error("[L2PS Batch Aggregator] Node keypair not available for HMAC generation")
        }

        const hmacKey = Buffer.from(sharedState.keypair.privateKey as Uint8Array)
            .toString("hex")
            .slice(0, 64)
        const hmacData = `${l2psUid}:${encryptedBatch}:${batchHash}:${transactionHashes.join(",")}`
        const authenticationTag = crypto
            .createHmac("sha256", hmacKey)
            .update(hmacData)
            .digest("hex")

        // Generate ZK proof if prover is available
        const zkProof = await this.generateZkProofForBatch(transactions, batchHash)

        return {
            l2ps_uid: l2psUid,
            encrypted_batch: encryptedBatch,
            transaction_count: transactions.length,
            batch_hash: batchHash,
            transaction_hashes: transactionHashes,
            authentication_tag: authenticationTag,
            zk_proof: zkProof,
        }
    }

    /**
     * Generate ZK-SNARK PLONK proof for batch validity
     * 
     * Creates a zero-knowledge proof that batch state transitions are valid
     * without revealing the actual transaction data.
     * 
     * @param transactions - Transactions to prove
     * @param batchHash - Deterministic batch hash as initial state root
     * @returns ZK proof data or undefined if prover not available
     */
    private async generateZkProofForBatch(
        transactions: L2PSMempoolTx[],
        batchHash: string
    ): Promise<L2PSBatchPayload['zk_proof'] | undefined> {
        if (!this.zkEnabled || !this.zkProver) {
            return undefined
        }

        try {
            // Convert transactions to ZK-friendly format using the amount from tx content when present.
            // If absent, fallback to 0n to avoid failing the batching loop.
            const zkTransactions = transactions.map((tx) => {
                // Safely convert amount to BigInt with validation
                const rawAmount = (tx.encrypted_tx as any)?.content?.amount
                let amount: bigint
                try {
                    amount = rawAmount !== undefined && rawAmount !== null
                        ? BigInt(Math.floor(Number(rawAmount)))
                        : 0n
                } catch {
                    amount = 0n
                }

                // Neutral before/after while preserving the invariant:
                // senderAfter = senderBefore - amount, receiverAfter = receiverBefore + amount.
                const senderBefore = amount
                const senderAfter = senderBefore - amount
                const receiverBefore = 0n
                const receiverAfter = receiverBefore + amount

                return {
                    senderBefore,
                    senderAfter,
                    receiverBefore,
                    receiverAfter,
                    amount,
                }
            })

            // Use batch hash as initial state root
            let initialStateRoot: bigint
            try {
                initialStateRoot = BigInt('0x' + batchHash.slice(0, 32)) % (2n ** 253n)
            } catch {
                initialStateRoot = 0n
            }

            log.debug(`[L2PS Batch Aggregator] Generating ZK proof for ${transactions.length} transactions...`)
            const startTime = Date.now()

            const proof = await this.zkProver.generateProof({
                transactions: zkTransactions,
                initialStateRoot,
            })

            // Safety: verify proof locally to catch corrupted zkey/wasm early.
            const isValid = await this.zkProver.verifyProof(proof)
            if (!isValid) {
                throw new Error("Generated ZK proof did not verify")
            }

            const duration = Date.now() - startTime
            log.info(`[L2PS Batch Aggregator] ZK proof generated in ${duration}ms (batch_${proof.batchSize})`)

            return {
                proof: proof.proof,
                publicSignals: proof.publicSignals,
                batchSize: proof.batchSize,
                finalStateRoot: proof.finalStateRoot.toString(),
                totalVolume: proof.totalVolume.toString(),
            }
        } catch (error) {
            const errorMessage = getErrorMessage(error)
            log.warning(`[L2PS Batch Aggregator] ZK proof generation failed: ${errorMessage}`)
            log.warning("[L2PS Batch Aggregator] Batch will be submitted without ZK proof")
            return undefined
        }
    }

    /**
     * Get next persistent nonce for batch transactions
     * 
     * Uses a monotonically increasing counter that persists the last used
     * nonce to ensure uniqueness across restarts and prevent replay attacks.
     * Falls back to timestamp-based nonce if storage is unavailable.
     * 
     * @returns Promise resolving to the next nonce value
     */
    private async getNextBatchNonce(): Promise<number> {
        // Get last nonce from persistent storage
        const lastNonce = await this.getLastNonceFromStorage()
        const timestamp = Date.now()
        const timestampNonce = timestamp * 1000

        // Ensure new nonce is always greater than last used
        const newNonce = Math.max(timestampNonce, lastNonce + 1)

        // Persist the new nonce for recovery after restart
        await this.saveNonceToStorage(newNonce)

        return newNonce
    }

    /**
     * Retrieve last used nonce from persistent storage
     */
    private async getLastNonceFromStorage(): Promise<number> {
        try {
            const sharedState = getSharedState
            // Use shared state to persist nonce across the session
            // This survives within the same process lifetime
            if (sharedState.l2psBatchNonce) {
                return sharedState.l2psBatchNonce
            }
            return 0
        } catch {
            return 0
        }
    }

    /**
     * Save nonce to persistent storage
     */
    private async saveNonceToStorage(nonce: number): Promise<void> {
        try {
            const sharedState = getSharedState
            // Store in shared state for persistence
            sharedState.l2psBatchNonce = nonce
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error'
            log.warning(`[L2PS Batch Aggregator] Failed to persist nonce: ${errorMessage}`)
        }
    }

    /**
     * Submit a batch transaction to the main mempool
     * 
     * Creates a transaction of type 'l2psBatch' and submits it to the main
     * mempool for inclusion in the next block. Uses domain-separated signatures
     * to prevent cross-protocol signature reuse.
     * 
     * @param batchPayload - Encrypted batch payload (includes l2ps_uid)
     * @returns true if submission was successful
     */
    private async submitBatchToMempool(batchPayload: L2PSBatchPayload): Promise<boolean> {
        try {
            const sharedState = getSharedState

            // Enforce proof verification before a batch enters the public mempool.
            if (this.zkEnabled && batchPayload.zk_proof) {
                if (!this.zkProver) {
                    log.error("[L2PS Batch Aggregator] ZK proof provided but zkProver is not initialized")
                    return false
                }

                const { proof, publicSignals, batchSize, finalStateRoot, totalVolume } = batchPayload.zk_proof

                let finalStateRootBigInt: bigint
                let totalVolumeBigInt: bigint
                try {
                    finalStateRootBigInt = BigInt(finalStateRoot)
                    totalVolumeBigInt = BigInt(totalVolume)
                } catch {
                    log.error(`[L2PS Batch Aggregator] Invalid BigInt values in ZK proof`)
                    return false
                }

                const isValid = await this.zkProver.verifyProof({
                    proof,
                    publicSignals,
                    batchSize: batchSize as any,
                    txCount: batchPayload.transaction_count,
                    finalStateRoot: finalStateRootBigInt,
                    totalVolume: totalVolumeBigInt,
                })
                if (!isValid) {
                    log.error(`[L2PS Batch Aggregator] Rejecting batch ${batchPayload.batch_hash.substring(0, 16)}...: invalid ZK proof`)
                    return false
                }
            }

            // Use keypair.publicKey (set by loadIdentity) instead of identity.ed25519
            if (!sharedState.keypair?.publicKey) {
                log.error("[L2PS Batch Aggregator] Node keypair not loaded yet")
                return false
            }

            // Get node's public key as hex string for 'from' field
            const nodeIdentityHex = uint8ArrayToHex(sharedState.keypair.publicKey as Uint8Array)

            // Use persistent nonce for batch transactions
            // This ensures uniqueness and proper ordering, preventing replay attacks
            const batchNonce = await this.getNextBatchNonce()

            // Create batch transaction content
            const transactionContent = {
                type: "l2psBatch",
                from: nodeIdentityHex,
                to: nodeIdentityHex, // Self-directed for relay
                from_ed25519_address: nodeIdentityHex,
                amount: 0,
                timestamp: getNetworkTimestamp(),
                nonce: batchNonce,
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

            // Sign with domain separation to prevent cross-protocol signature reuse
            // Domain prefix ensures this signature cannot be replayed in other contexts
            const domainSeparatedMessage = `${this.SIGNATURE_DOMAIN}:${contentString}`
            const signature = await TxValidatorPool.getInstance().sign(
                sharedState.signingAlgorithm,
                new TextEncoder().encode(domainSeparatedMessage),
            )

            // Create batch transaction object matching mempool expectations
            // Note: status and extra fields are required by MempoolTx entity
            const batchTransaction = {
                hash,
                content: transactionContent,
                signature: signature ? {
                    type: sharedState.signingAlgorithm,
                    data: uint8ArrayToHex(signature.signature),
                    domain: this.SIGNATURE_DOMAIN, // Include domain for verification
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

        } catch (error: unknown) {
            const message = getErrorMessage(error)
            log.error(`[L2PS Batch Aggregator] Error submitting batch to mempool: ${message}`)
            if (error instanceof Error && error.stack) {
                log.debug(`[L2PS Batch Aggregator] Stack trace: ${error.stack}`)
            }
            return false
        }
    }

    /**
     * Cleanup old confirmed transactions
     * 
     * Removes transactions that have been in 'confirmed' status for longer
     * than the cleanup age threshold. This prevents the L2PS mempool from
     * growing indefinitely.
     */
    private async cleanupOldBatchedTransactions(): Promise<void> {
        try {
            const deleted = await L2PSMempool.cleanupByStatus(
                L2PS_STATUS.CONFIRMED,
                this.CLEANUP_AGE_MS,
            )

            if (deleted > 0) {
                this.stats.cleanedUpTransactions += deleted
                log.info(`[L2PS Batch Aggregator] Cleaned up ${deleted} old confirmed transactions`)
            }

        } catch (error: unknown) {
            const message = getErrorMessage(error)
            log.error(`[L2PS Batch Aggregator] Error during cleanup: ${message}`)
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
            joinedL2PSCount: getSharedState.l2psJoinedUids?.length || 0,
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
