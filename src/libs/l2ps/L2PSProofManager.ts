/**
 * L2PS Proof Manager
 * 
 * Manages ZK proofs for the unified L1/L2PS state architecture.
 * Instead of L2PS having separate state, proofs encode state changes
 * that are applied to L1 at consensus time.
 * 
 * Flow:
 * 1. L2PS transactions are validated and GCR edits are generated
 * 2. A proof is created encoding these GCR edits
 * 3. Proof is stored in l2ps_proofs table with status "pending"
 * 4. At consensus, pending proofs are read and verified
 * 5. Verified proofs' GCR edits are applied to main gcr_main (L1 state)
 * 
 * Proof Systems:
 * - PLONK (preferred): Universal trusted setup, flexible circuit updates
 * - Groth16: Smaller proofs, requires circuit-specific setup
 * - Placeholder: Development mode, hash-based verification
 * 
 * @module L2PSProofManager
 */

import { Repository } from "typeorm"
import Datasource from "@/model/datasource"
import { L2PSProof, L2PSProofStatus } from "@/model/entities/L2PSProofs"
import type { GCREdit } from "@kynesyslabs/demosdk/types"
import Hashing from "@/libs/crypto/hashing"
import log from "@/utilities/logger"

/**
 * Deterministic JSON stringify that sorts keys alphabetically
 * This ensures consistent hashing regardless of key order (important after PostgreSQL JSONB round-trip)
 */
function deterministicStringify(obj: any): string {
    return JSON.stringify(obj, (key, value) => {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            return Object.keys(value).sort((a, b) => a.localeCompare(b)).reduce((sorted: any, k) => {
                sorted[k] = value[k]
                return sorted
            }, {})
        }
        return value
    })
}

/**
 * Result of creating a proof
 */
export interface ProofCreationResult {
    success: boolean
    message: string
    proof_id?: number
    transactions_hash?: string
}

/**
 * Result of applying a proof
 */
export interface ProofApplicationResult {
    success: boolean
    message: string
    edits_applied: number
    affected_accounts: string[]
}

/**
 * L2PS Proof Manager
 * 
 * Handles proof creation, storage, verification, and application.
 */
export default class L2PSProofManager {
    private static repo: Repository<L2PSProof> | null = null
    private static initPromise: Promise<void> | null = null

    /**
     * Initialize the repository
     */
    private static async init(): Promise<void> {
        if (this.repo) return
        if (this.initPromise !== null) {
            await this.initPromise
            return
        }

        this.initPromise = (async () => {
            const dsInstance = await Datasource.getInstance()
            const ds = dsInstance.getDataSource()
            this.repo = ds.getRepository(L2PSProof)
            log.info("[L2PS ProofManager] Repository initialized")
        })()

        await this.initPromise
    }

    private static async getRepo(): Promise<Repository<L2PSProof>> {
        await this.init()
        return this.repo!
    }

    /**
     * Create a proof from L2PS transaction GCR edits
     * 
     * @param l2psUid - L2PS network identifier
     * @param l1BatchHash - Hash of the L1 batch transaction
     * @param gcrEdits - GCR edits that should be applied to L1
     * @param affectedAccounts - Accounts affected by these edits
     * @param transactionCount - Number of L2PS transactions in this proof
     * @param transactionHashes - Individual transaction hashes from L2PS mempool
     * @returns Proof creation result
     */
    static async createProof(
        l2psUid: string,
        l1BatchHash: string,
        gcrEdits: GCREdit[],
        affectedAccounts: string[],
        transactionCount: number = 1,
        transactionHashes: string[] = []
    ): Promise<ProofCreationResult> {
        try {
            const repo = await this.getRepo()

            // Generate deterministic transactions hash
            const transactionsHash = Hashing.sha256(
                deterministicStringify({ l2psUid, l1BatchHash, gcrEdits })
            )

            // Create hash-based proof for state transition verification
            const proofData = Hashing.sha256(deterministicStringify({
                l2psUid,
                l1BatchHash,
                gcrEdits,
                affectedAccounts,
                transactionsHash
            }))

            const proof: L2PSProof["proof"] = {
                type: "hash",
                data: proofData,
                public_inputs: [l2psUid, l1BatchHash, transactionsHash]
            }

            const proofEntity = repo.create({
                l2ps_uid: l2psUid,
                l1_batch_hash: l1BatchHash,
                proof,
                gcr_edits: gcrEdits,
                affected_accounts: affectedAccounts,
                status: "pending" as L2PSProofStatus,
                transaction_count: transactionCount,
                transactions_hash: transactionsHash,
                transaction_hashes: transactionHashes
            })

            const saved = await repo.save(proofEntity)

            log.info(`[L2PS ProofManager] Created proof ${saved.id} for L2PS ${l2psUid} with ${gcrEdits.length} edits`)

            return {
                success: true,
                message: `Proof created with ${gcrEdits.length} GCR edits`,
                proof_id: saved.id,
                transactions_hash: transactionsHash
            }
        } catch (error: any) {
            const message = error instanceof Error ? error.message : ((error as any)?.message || String(error))
            log.error(`[L2PS ProofManager] Failed to create proof: ${message}`)
            return {
                success: false,
                message: `Proof creation failed: ${message}`
            }
        }
    }

    /**
     * Get all pending proofs for a given L2PS network
     * Called at consensus time to gather proofs for application
     * 
     * @param l2psUid - L2PS network identifier (optional, gets all if not specified)
     * @returns Array of pending proofs
     */
    static async getPendingProofs(l2psUid?: string): Promise<L2PSProof[]> {
        const repo = await this.getRepo()

        const where: any = { status: "pending" as L2PSProofStatus }
        if (l2psUid) {
            where.l2ps_uid = l2psUid
        }

        return repo.find({
            where,
            order: { created_at: "ASC" }
        })
    }

    /**
     * Get pending proofs for a specific block
     * 
     * @param blockNumber - Target block number
     * @returns Array of proofs targeting this block
     */
    static async getProofsForBlock(blockNumber: number): Promise<L2PSProof[]> {
        const repo = await this.getRepo()

        // FUTURE: Filter proofs by target_block_number when block-specific batching is implemented
        // For now, returns all pending proofs in creation order (blockNumber reserved for future use)
        return repo.find({
            where: {
                status: "pending" as L2PSProofStatus
            },
            order: { created_at: "ASC" }
        })
    }

    /**
     * Verify a proof using hash verification
     * 
     * @param proof - The proof to verify
     * @returns Whether the proof is valid
     */
    static async verifyProof(proof: L2PSProof): Promise<boolean> {
        try {
            // Basic structure validation
            if (!proof.proof || !proof.gcr_edits || proof.gcr_edits.length === 0) {
                log.warning(`[L2PS ProofManager] Proof ${proof.id} has invalid structure`)
                return false
            }

            // Validate each GCR edit has required fields
            for (const edit of proof.gcr_edits) {
                if (!edit.type || (edit.type === 'balance' && !('account' in edit))) {
                    log.warning(`[L2PS ProofManager] Proof ${proof.id} has invalid GCR edit`)
                    return false
                }
            }

            // Verify hash matches expected structure
            const expectedHash = Hashing.sha256(deterministicStringify({
                l2psUid: proof.l2ps_uid,
                l1BatchHash: proof.l1_batch_hash,
                gcrEdits: proof.gcr_edits,
                affectedAccounts: proof.affected_accounts,
                transactionsHash: proof.transactions_hash
            }))

            if (proof.proof.data !== expectedHash) {
                log.warning(`[L2PS ProofManager] Proof ${proof.id} hash mismatch`)
                return false
            }

            log.debug(`[L2PS ProofManager] Proof ${proof.id} verified`)
            return true
        } catch (error) {
            const message = error instanceof Error ? error.message : ((error as any)?.message || String(error))
            log.error(`[L2PS ProofManager] Proof verification failed: ${message}`)
            return false
        }
    }

    /**
     * Mark proof as applied after consensus
     * 
     * @param proofId - Proof ID
     * @param blockNumber - Block number where proof was applied
     */
    static async markProofApplied(proofId: number, blockNumber: number): Promise<void> {
        const repo = await this.getRepo()
        
        await repo.update(proofId, {
            status: "applied" as L2PSProofStatus,
            applied_block_number: blockNumber,
            processed_at: new Date()
        })

        log.info(`[L2PS ProofManager] Marked proof ${proofId} as applied in block ${blockNumber}`)
    }

    /**
     * Mark proof as rejected
     * 
     * @param proofId - Proof ID
     * @param errorMessage - Reason for rejection
     */
    static async markProofRejected(proofId: number, errorMessage: string): Promise<void> {
        const repo = await this.getRepo()
        
        await repo.update(proofId, {
            status: "rejected" as L2PSProofStatus,
            error_message: errorMessage,
            processed_at: new Date()
        })

        log.warning(`[L2PS ProofManager] Marked proof ${proofId} as rejected: ${errorMessage}`)
    }

    /**
     * Get proof by L1 batch hash
     * 
     * @param l1BatchHash - L1 batch transaction hash
     * @returns Proof or null
     */
    static async getProofByBatchHash(l1BatchHash: string): Promise<L2PSProof | null> {
        const repo = await this.getRepo()
        return repo.findOne({ where: { l1_batch_hash: l1BatchHash } })
    }

    /**
     * Get proofs for an L2PS network with optional status filter
     * 
     * @param l2psUid - L2PS network identifier
     * @param status - Optional status filter
     * @param limit - Max results
     * @returns Array of proofs
     */
    static async getProofs(
        l2psUid: string,
        status?: L2PSProofStatus,
        limit: number = 100
    ): Promise<L2PSProof[]> {
        const repo = await this.getRepo()

        const where: any = { l2ps_uid: l2psUid }
        if (status) {
            where.status = status
        }

        return repo.find({
            where,
            order: { created_at: "DESC" },
            take: limit
        })
    }

    /**
     * Get statistics for L2PS proofs
     */
    static async getStats(l2psUid?: string): Promise<{
        pending: number
        applied: number
        rejected: number
        total: number
    }> {
        const repo = await this.getRepo()

        const queryBuilder = repo.createQueryBuilder("proof")
        if (l2psUid) {
            queryBuilder.where("proof.l2ps_uid = :l2psUid", { l2psUid })
        }

        const [pending, applied, rejected, total] = await Promise.all([
            queryBuilder.clone().andWhere("proof.status = :status", { status: "pending" }).getCount(),
            queryBuilder.clone().andWhere("proof.status = :status", { status: "applied" }).getCount(),
            queryBuilder.clone().andWhere("proof.status = :status", { status: "rejected" }).getCount(),
            queryBuilder.clone().getCount()
        ])

        return { pending, applied, rejected, total }
    }
}
