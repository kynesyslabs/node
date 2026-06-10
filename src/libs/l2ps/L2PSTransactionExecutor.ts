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
import { denomination } from "@kynesyslabs/demosdk"
import L2PSProofManager from "./L2PSProofManager"
import HandleGCR from "@/libs/blockchain/gcr/handleGCR"
import {
    validateEditConservation,
    normalizeAccount,
} from "./editConservation"
import { canonicalizeAmountToOs } from "@/forks/amountCanonical"
import { isForkActive } from "@/forks/forkGates"
import { getSharedState } from "@/utilities/sharedState"
import log from "@/utilities/logger"
import { getErrorMessage } from "@/utilities/errorMessage"

/**
 * L2PS Transaction Fee (in DEM)
 * This fee is burned (removed from sender, not added anywhere)
 */
const L2PS_TX_FEE = 1

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
            where: { pubkey },
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
        simulate = false,
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
                affected_accounts_count: affectedAccountsCount,
            }

        } catch (error) {
            const message = getErrorMessage(error)
            log.error(`[L2PS Executor] Error: ${message}`)
            return {
                success: false,
                message: `Execution failed: ${message}`,
            }
        }
    }

    /**
     * Generate GCR edits based on transaction type
     */
    private static async generateGCREdits(
        tx: Transaction,
        simulate: boolean,
    ): Promise<L2PSExecutionResult> {
        const gcrEdits: GCREdit[] = []

        if (tx.content.type === "native") {
            return this.handleNativeTransaction(tx, simulate)
        }

        // Handle demoswork and other types with gcr_edits.
        //
        // AUDIT C4: these gcr_edits are passed through verbatim from a
        // participant-signed L2PS tx and later applied to L1 gcr_main at
        // consensus with NO ZK soundness (the proof is a sha256 self-check,
        // not a PLONK verify — see L2PSProofManager.verifyProof). Per-edit
        // validateGCREdit only checks a `remove` has balance, so before this
        // guard a signed tx could carry {balance,add,self,HUGE} (mint) or
        // {balance,remove,victim} (theft). Enforce two tx-level invariants
        // the canonical native path already satisfies:
        //   1. balance DEBITS (remove) may only touch the SIGNER's account —
        //      you cannot debit someone else;
        //   2. balance edits are zero-sum (Σremove == Σadd) — no net mint.
        // `add` may credit any account (legit transfers), as long as it is
        // funded by an equal remove from the signer.
        if (tx.content.gcr_edits && tx.content.gcr_edits.length > 0) {
            const signerAccounts: string[] = []
            for (const s of [
                tx.content.from,
                tx.content.from_ed25519_address,
            ]) {
                if (s != null) signerAccounts.push(normalizeAccount(s))
            }
            const conservation = validateEditConservation(
                tx.content.gcr_edits,
                signerAccounts,
            )
            if (!conservation.success) {
                return conservation
            }
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
        simulate: boolean,
    ): Promise<L2PSExecutionResult> {
        const nativePayloadData = tx.content.data as ["native", INativePayload]
        const nativePayload = nativePayloadData[1]
        const gcrEdits: GCREdit[] = []
        let affectedAccountsCount = 0

        if (nativePayload.nativeOperation === "send") {
            const [to, rawAmount] = nativePayload.args as [
                string,
                number | string,
            ]
            const sender = tx.content.from as string

            // Match the L1 native path: canonicalise the wire amount to
            // an OS bigint through the fork-aware helper, then emit GCR
            // edits in the magnitude the rest of the pipeline expects
            // (OS string post-fork, legacy DEM number pre-fork). Without
            // this the executor moves ~10^9× too little post-fork, and
            // post-fork OS string amounts are rejected outright by the
            // number-only validation that used to live here.
            const referenceHeight =
                getSharedState.lastBlockNumber ?? 0
            const forkActive = isForkActive(
                "osDenomination",
                referenceHeight,
            )

            // Canonicalise the wire amount and the fee in the same try
            // block so any unexpected failure surfaces with a uniform
            // "Invalid amount" error path. `L2PS_TX_FEE` is a constant
            // `1` today and will not throw, but keeping both calls in
            // the same guard prevents a silent regression if either
            // input shape ever drifts.
            let amountCanonical: bigint
            let feeCanonical: bigint
            try {
                amountCanonical = canonicalizeAmountToOs(
                    rawAmount,
                    forkActive,
                )
                // L2PS_TX_FEE is declared in DEM units (1 DEM).
                // Canonicalise the same way as the wire amount so the
                // balance check and the burn edit agree on units.
                feeCanonical = canonicalizeAmountToOs(
                    L2PS_TX_FEE,
                    forkActive,
                )
            } catch (e) {
                return {
                    success: false,
                    message: `Invalid amount: ${(e as Error).message}`,
                }
            }
            if (amountCanonical <= 0n) {
                return {
                    success: false,
                    message: "Invalid amount: must be a positive integer",
                }
            }

            // Check sender balance in L1 state (amount + fee). The L1
            // balance is persisted as an OS magnitude string, so compare
            // bigint-to-bigint regardless of fork status.
            const senderAccount = await this.getOrCreateL1Account(sender)
            const totalRequired = amountCanonical + feeCanonical
            if (BigInt(senderAccount.balance) < totalRequired) {
                return {
                    success: false,
                    message: `Insufficient L1 balance: has ${senderAccount.balance}, needs ${totalRequired} (${amountCanonical} + ${feeCanonical} fee)`,
                }
            }

            // Ensure receiver account exists
            await this.getOrCreateL1Account(to)

            // Emit GCR edits in the magnitude downstream consumers expect:
            // OS string post-fork (matches the serializerGate wire shape
            // the SDK ≥ v3.0.0 emits); pre-fork carries the legacy DEM
            // magnitude as a string too — `GCREditBalance.amount` accepts
            // `number | string`, and a string avoids the silent precision
            // loss that `Number(bigint)` would introduce for any amount
            // above `Number.MAX_SAFE_INTEGER`.
            const editAmount: string = forkActive
                ? denomination.toOsString(amountCanonical)
                : amountCanonical.toString()
            const editFee: string = forkActive
                ? denomination.toOsString(feeCanonical)
                : feeCanonical.toString()

            // 1. Burn the fee (remove from sender, no add anywhere)
            gcrEdits.push({
                type: "balance",
                operation: "remove",
                account: sender,
                amount: editFee,
                txhash: tx.hash,
                isRollback: false,
            })

            // 2. Transfer amount from sender to receiver
            gcrEdits.push(
                {
                    type: "balance",
                    operation: "remove",
                    account: sender,
                    amount: editAmount,
                    txhash: tx.hash,
                    isRollback: false,
                },
                {
                    type: "balance",
                    operation: "add",
                    account: to,
                    amount: editAmount,
                    txhash: tx.hash,
                    isRollback: false,
                },
            )

            // Count unique accounts (sender and receiver)
            affectedAccountsCount = sender === to ? 1 : 2
        } else {
            log.debug(`[L2PS Executor] Unknown native operation: ${nativePayload.nativeOperation}`)
            return {
                success: true,
                message: `Native operation '${nativePayload.nativeOperation}' not implemented`,
                affected_accounts_count: 1,
            }
        }

        return {
            success: true,
            message: "Native transaction validated",
            gcr_edits: gcrEdits,
            affected_accounts_count: affectedAccountsCount,
        }
    }

    /**
     * Validate a GCR edit against L1 state (without applying it)
     */
    private static async validateGCREdit(
        edit: GCREdit,
        simulate: boolean,
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
                            message: `Insufficient L1 balance for ${edit.account}: has ${currentBalance}, needs ${edit.amount}`,
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
        batchIndex = 0,
        initialStatus: "pending" | "batched" | "confirmed" | "failed" = "pending",
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
            status: initialStatus,
            content: tx.content as Record<string, any>,
            execution_message: null,
        })

        const saved = await txRepo.save(l2psTx)
        log.info(`[L2PS Executor] Recorded tx ${tx.hash.slice(0, 16)}... in L2PS ${l2psUid} (id: ${saved.id}, status: ${initialStatus})`)
        return saved.id
    }

    /**
     * Update transaction status after proof is applied at consensus
     */
    static async updateTransactionStatus(
        txHash: string,
        status: "pending" | "batched" | "confirmed" | "failed",
        l1BlockNumber?: number,
        message?: string,
        l1BatchHash?: string,
    ): Promise<void> {
        await this.init()
        const dsInstance = await Datasource.getInstance()
        const ds = dsInstance.getDataSource()
        const txRepo = ds.getRepository(L2PSTransaction)

        const updateData: any = { status }
        if (l1BlockNumber) updateData.l1_block_number = l1BlockNumber
        if (message) updateData.execution_message = message
        if (l1BatchHash) updateData.l1_batch_hash = l1BatchHash

        // Search by either original hash OR encrypted hash
        // This is important because consensus uses the encrypted hash from proofs
        const result = await txRepo.createQueryBuilder()
            .update(L2PSTransaction)
            .set(updateData)
            .where("hash = :hash OR encrypted_hash = :hash", { hash: txHash })
            .execute()

        if (result.affected === 0) {
            log.warning(`[L2PS Executor] No transaction found with hash/encrypted_hash ${txHash.slice(0, 16)}...`)
        } else {
            log.info(`[L2PS Executor] Updated ${result.affected} tx(s) matching ${txHash.slice(0, 16)}... status to ${status}`)
        }
    }

    /**
     * Get transactions for an account (from l2ps_transactions table)
     */
    static async getAccountTransactions(
        l2psUid: string,
        pubkey: string,
        limit = 100,
        offset = 0,
    ): Promise<L2PSTransaction[]> {
        await this.init()
        const dsInstance = await Datasource.getInstance()
        const ds = dsInstance.getDataSource()
        const txRepo = ds.getRepository(L2PSTransaction)

        // Use query builder to get unique transactions where user is sender or receiver
        // This prevents duplicates when from_address === to_address (self-transfer)
        const transactions = await txRepo.createQueryBuilder("tx")
            .where("tx.l2ps_uid = :l2psUid", { l2psUid })
            .andWhere("(tx.from_address = :pubkey OR tx.to_address = :pubkey)", { pubkey })
            .orderBy("tx.timestamp", "DESC")
            .take(limit)
            .skip(offset)
            .getMany()

        return transactions
    }

    /**
     * Get transaction by hash
     */
    static async getTransactionByHash(
        l2psUid: string,
        hash: string,
    ): Promise<L2PSTransaction | null> {
        await this.init()
        const dsInstance = await Datasource.getInstance()
        const ds = dsInstance.getDataSource()
        const txRepo = ds.getRepository(L2PSTransaction)

        return txRepo.findOne({
            where: { l2ps_uid: l2psUid, hash },
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
            appliedProofs: proofStats.applied,
        }
    }
}
