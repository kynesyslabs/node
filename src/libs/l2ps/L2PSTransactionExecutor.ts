/**
 * L2PS Transaction Executor (Unified State Architecture)
 *
 * Executes L2PS transactions using the UNIFIED STATE approach:
 * - L2PS does NOT have its own separate state (no l2ps_gcr_main)
 * - Transactions are validated against L1 state (gcr_main)
 * - GCR edits are generated and stored in mempool for batch aggregation
 * - Batch aggregator creates a single proof per batch (not per transaction)
 * - Proofs are applied to L1 state at consensus time
 *
 * This implements the "private layer on L1" architecture:
 * - L2PS provides privacy through encryption
 * - State changes are applied to L1 via ZK proofs
 * - Validators participate in consensus without seeing tx content
 *
 * @module L2PSTransactionExecutor
 */

import { Repository } from "typeorm"
import Datasource from "@/model/datasource"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { L2PSTransaction } from "@/model/entities/L2PSTransactions"
import type { Transaction, GCREdit, INativePayload } from "@kynesyslabs/demosdk/types"
import L2PSProofManager from "./L2PSProofManager"
import HandleGCR from "@/libs/blockchain/gcr/handleGCR"
import log from "@/utilities/logger"
import { getErrorMessage } from "@/utilities/errorMessage"

/**
 * Result of executing an L2PS transaction
 */
export interface L2PSExecutionResult {
    success: boolean
    message: string
    /** GCR edits generated (will be applied to L1 at consensus) */
    gcr_edits?: GCREdit[]
    /** Number of accounts affected (privacy-preserving - not actual addresses) */
    affected_accounts_count?: number
    /** Proof ID if proof was created */
    proof_id?: number
    /** Transaction ID in l2ps_transactions table */
    transaction_id?: number
}

/**
 * L2PS Transaction Executor (Unified State)
 * 
 * Validates transactions against L1 state and generates proofs
 * for consensus-time application.
 */
export default class L2PSTransactionExecutor {
    /** Repository for L1 state (gcr_main) - used for validation */
    private static l1Repo: Repository<GCRMain> | null = null
    private static initPromise: Promise<void> | null = null

    /**
     * Initialize the repository
     */
    private static async init(): Promise<void> {
        if (this.l1Repo) return
        if (this.initPromise !== null) {
            await this.initPromise
            return
        }

        this.initPromise = (async () => {
            const dsInstance = await Datasource.getInstance()
            const ds = dsInstance.getDataSource()
            this.l1Repo = ds.getRepository(GCRMain)
            log.info("[L2PS Executor] Repository initialized (unified state mode)")
        })()

        await this.initPromise
    }

    private static async getL1Repo(): Promise<Repository<GCRMain>> {
        await this.init()
        return this.l1Repo!
    }

    /**
     * Get or create account in L1 state
     * Uses the same GCR_Main table as regular L1 transactions
     */
    private static async getOrCreateL1Account(pubkey: string): Promise<GCRMain> {
        const repo = await this.getL1Repo()
        
        let account = await repo.findOne({
            where: { pubkey }
        })

        if (!account) {
            // Use HandleGCR to create account (same as L1)
            account = await HandleGCR.createAccount(pubkey)
            log.info(`[L2PS Executor] Created L1 account ${pubkey.slice(0, 16)}... for L2PS tx`)
        }

        return account
    }

    /**
     * Execute a decrypted L2PS transaction
     *
     * UNIFIED STATE APPROACH:
     * 1. Validate transaction against L1 state (gcr_main)
     * 2. Generate GCR edits (same as L1 transactions)
     * 3. Return GCR edits - proof creation happens at batch aggregation time
     *
     * @param l2psUid - L2PS network identifier (for tracking/privacy scope)
     * @param tx - Decrypted L2PS transaction
     * @param l1BatchHash - L1 batch transaction hash (for tracking)
     * @param simulate - If true, only validate without storing edits
     */
    static async execute(
        l2psUid: string,
        tx: Transaction,
        l1BatchHash: string,
        simulate: boolean = false
    ): Promise<L2PSExecutionResult> {
        try {
            log.info(`[L2PS Executor] Processing tx ${tx.hash} from L2PS ${l2psUid} (type: ${tx.content.type})`)
            
            // Generate GCR edits based on transaction type
            const editsResult = await this.generateGCREdits(tx, simulate)
            if (!editsResult.success) {
                return editsResult
            }

            const gcrEdits = editsResult.gcr_edits || []
            const affectedAccountsCount = editsResult.affected_accounts_count || 0

            // Return GCR edits - proof creation is handled at batch time
            // This allows multiple transactions to be aggregated into a single proof
            return {
                success: true,
                message: simulate
                    ? `Validated: ${gcrEdits.length} GCR edits would be generated`
                    : `Executed: ${gcrEdits.length} GCR edits generated (will be batched)`,
                gcr_edits: gcrEdits,
                affected_accounts_count: affectedAccountsCount
            }

        } catch (error) {
            const message = getErrorMessage(error)
            log.error(`[L2PS Executor] Error: ${message}`)
            return {
                success: false,
                message: `Execution failed: ${message}`
            }
        }
    }

    /**
     * Generate GCR edits based on transaction type
     */
    private static async generateGCREdits(
        tx: Transaction,
        simulate: boolean
    ): Promise<L2PSExecutionResult> {
        const gcrEdits: GCREdit[] = []

        if (tx.content.type === "native") {
            return this.handleNativeTransaction(tx, simulate)
        }

        // Handle demoswork and other types with gcr_edits
        if (tx.content.gcr_edits && tx.content.gcr_edits.length > 0) {
            for (const edit of tx.content.gcr_edits) {
                const editResult = await this.validateGCREdit(edit, simulate)
                if (!editResult.success) {
                    return editResult
                }
                gcrEdits.push(edit)
            }
            return { success: true, message: "GCR edits validated", gcr_edits: gcrEdits, affected_accounts_count: 1 }
        }

        // No GCR edits - just record
        const message = tx.content.type === "demoswork"
            ? "DemosWork transaction recorded (no GCR edits)"
            : `Transaction type '${tx.content.type}' recorded`
        return { success: true, message, affected_accounts_count: 1 }
    }

    /**
     * Handle native transaction - validate against L1 state and generate GCR edits
     */
    private static async handleNativeTransaction(
        tx: Transaction,
        simulate: boolean
    ): Promise<L2PSExecutionResult> {
        const nativePayloadData = tx.content.data as ["native", INativePayload]
        const nativePayload = nativePayloadData[1]
        const gcrEdits: GCREdit[] = []
        let affectedAccountsCount = 0

        if (nativePayload.nativeOperation === "send") {
            const [to, amount] = nativePayload.args as [string, number]
            const sender = tx.content.from as string

            // Validate amount (type check and positive)
            if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
                return { success: false, message: "Invalid amount: must be a positive number" }
            }

            // Check sender balance in L1 state
            const senderAccount = await this.getOrCreateL1Account(sender)
            if (BigInt(senderAccount.balance) < BigInt(amount)) {
                return {
                    success: false,
                    message: `Insufficient L1 balance: has ${senderAccount.balance}, needs ${amount}`
                }
            }

            // Ensure receiver account exists
            await this.getOrCreateL1Account(to)

            // Generate GCR edits for L1 state change
            // These will be applied at consensus time
            gcrEdits.push(
                {
                    type: "balance",
                    operation: "remove",
                    account: sender,
                    amount: amount,
                    txhash: tx.hash,
                    isRollback: false
                },
                {
                    type: "balance",
                    operation: "add",
                    account: to,
                    amount: amount,
                    txhash: tx.hash,
                    isRollback: false
                }
            )

            // Count unique accounts (sender and receiver)
            affectedAccountsCount = sender === to ? 1 : 2
        } else {
            log.debug(`[L2PS Executor] Unknown native operation: ${nativePayload.nativeOperation}`)
            return {
                success: true,
                message: `Native operation '${nativePayload.nativeOperation}' not implemented`,
                affected_accounts_count: 1
            }
        }

        return {
            success: true,
            message: "Native transaction validated",
            gcr_edits: gcrEdits,
            affected_accounts_count: affectedAccountsCount
        }
    }

    /**
     * Validate a GCR edit against L1 state (without applying it)
     */
    private static async validateGCREdit(
        edit: GCREdit,
        simulate: boolean
    ): Promise<L2PSExecutionResult> {
        // Ensure init is called before validation
        await this.init()

        switch (edit.type) {
            case "balance": {
                const account = await this.getOrCreateL1Account(edit.account as string)
                
                if (edit.operation === "remove") {
                    const currentBalance = BigInt(account.balance)
                    if (currentBalance < BigInt(edit.amount)) {
                        return {
                            success: false,
                            message: `Insufficient L1 balance for ${edit.account}: has ${currentBalance}, needs ${edit.amount}`
                        }
                    }
                }
                break
            }

            case "nonce":
                // Nonce edits are always valid (just increment)
                break

            default:
                log.debug(`[L2PS Executor] GCR edit type '${edit.type}' validation skipped`)
        }

        return { success: true, message: `Validated ${edit.type} edit` }
    }

    /**
     * Record transaction in l2ps_transactions table
     */
    static async recordTransaction(
        l2psUid: string,
        tx: Transaction,
        l1BatchHash: string,
        encryptedHash?: string,
        batchIndex: number = 0
    ): Promise<number> {
        await this.init()
        const dsInstance = await Datasource.getInstance()
        const ds = dsInstance.getDataSource()
        const txRepo = ds.getRepository(L2PSTransaction)
        
        const l2psTx = txRepo.create({
            l2ps_uid: l2psUid,
            hash: tx.hash,
            encrypted_hash: encryptedHash || null,
            l1_batch_hash: l1BatchHash,
            batch_index: batchIndex,
            type: tx.content.type,
            from_address: tx.content.from as string,
            to_address: tx.content.to as string,
            amount: BigInt(tx.content.amount || 0),
            nonce: BigInt(tx.content.nonce || 0),
            timestamp: BigInt(tx.content.timestamp || Date.now()),
            status: "pending", // Will change to "applied" after consensus
            content: tx.content as Record<string, any>,
            execution_message: null
        })

        const saved = await txRepo.save(l2psTx)
        log.info(`[L2PS Executor] Recorded tx ${tx.hash.slice(0, 16)}... in L2PS ${l2psUid} (id: ${saved.id})`)
        return saved.id
    }

    /**
     * Update transaction status after proof is applied at consensus
     */
    static async updateTransactionStatus(
        txHash: string,
        status: "applied" | "rejected",
        l1BlockNumber?: number,
        message?: string
    ): Promise<void> {
        await this.init()
        const dsInstance = await Datasource.getInstance()
        const ds = dsInstance.getDataSource()
        const txRepo = ds.getRepository(L2PSTransaction)

        const updateData: any = { status }
        if (l1BlockNumber) updateData.l1_block_number = l1BlockNumber
        if (message) updateData.execution_message = message

        const result = await txRepo.update({ hash: txHash }, updateData)
        if (result.affected === 0) {
            log.warning(`[L2PS Executor] No transaction found with hash ${txHash.slice(0, 16)}...`)
        } else {
            log.info(`[L2PS Executor] Updated tx ${txHash.slice(0, 16)}... status to ${status}`)
        }
    }

    /**
     * Get transactions for an account (from l2ps_transactions table)
     */
    static async getAccountTransactions(
        l2psUid: string,
        pubkey: string,
        limit: number = 100,
        offset: number = 0
    ): Promise<L2PSTransaction[]> {
        await this.init()
        const dsInstance = await Datasource.getInstance()
        const ds = dsInstance.getDataSource()
        const txRepo = ds.getRepository(L2PSTransaction)

        return txRepo.find({
            where: [
                { l2ps_uid: l2psUid, from_address: pubkey },
                { l2ps_uid: l2psUid, to_address: pubkey }
            ],
            order: { timestamp: "DESC" },
            take: limit,
            skip: offset
        })
    }

    /**
     * Get transaction by hash
     */
    static async getTransactionByHash(
        l2psUid: string,
        hash: string
    ): Promise<L2PSTransaction | null> {
        await this.init()
        const dsInstance = await Datasource.getInstance()
        const ds = dsInstance.getDataSource()
        const txRepo = ds.getRepository(L2PSTransaction)

        return txRepo.findOne({
            where: { l2ps_uid: l2psUid, hash }
        })
    }

    /**
     * Get balance for an account from L1 state
     * In unified state architecture, L2PS reads from L1 (gcr_main)
     */
    static async getBalance(pubkey: string): Promise<bigint> {
        const account = await this.getOrCreateL1Account(pubkey)
        return BigInt(account.balance)
    }

    /**
     * Get nonce for an account from L1 state
     */
    static async getNonce(pubkey: string): Promise<bigint> {
        const account = await this.getOrCreateL1Account(pubkey)
        return BigInt(account.nonce)
    }

    /**
     * Get full account state from L1
     */
    static async getAccountState(pubkey: string): Promise<GCRMain> {
        return this.getOrCreateL1Account(pubkey)
    }

    /**
     * Get network statistics for L2PS
     */
    static async getNetworkStats(l2psUid: string): Promise<{
        totalTransactions: number
        pendingProofs: number
        appliedProofs: number
    }> {
        const dsInstance = await Datasource.getInstance()
        const ds = dsInstance.getDataSource()
        const txRepo = ds.getRepository(L2PSTransaction)
        
        const txCount = await txRepo.count({ where: { l2ps_uid: l2psUid } })
        const proofStats = await L2PSProofManager.getStats(l2psUid)
        
        return {
            totalTransactions: txCount,
            pendingProofs: proofStats.pending,
            appliedProofs: proofStats.applied
        }
    }
}
