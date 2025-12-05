/**
 * L2PS Proofs Entity
 * 
 * Stores ZK proofs for L2PS transactions that encode state changes.
 * Proofs are read at consensus time and applied to the main L1 state (gcr_main).
 * 
 * Architecture:
 * - L2PS transactions generate proofs instead of modifying separate L2 state
 * - Proofs contain GCR edits that will be applied to L1 at consensus
 * - This enables "private layer on L1" - unified state with privacy
 * 
 * @module L2PSProofs
 */

import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    Index,
    CreateDateColumn,
} from "typeorm"
import type { GCREdit } from "@kynesyslabs/demosdk/types"

/**
 * Status of an L2PS proof
 */
export type L2PSProofStatus = 
    | "pending"     // Proof generated, waiting for consensus
    | "applied"     // Proof verified and GCR edits applied at consensus
    | "rejected"    // Proof verification failed
    | "expired"     // Proof not applied within timeout

/**
 * L2PS Proof Entity
 * 
 * Stores ZK proofs with their GCR edits for application at consensus.
 */
@Entity("l2ps_proofs")
@Index("IDX_L2PS_PROOFS_UID", ["l2ps_uid"])
@Index("IDX_L2PS_PROOFS_STATUS", ["status"])
@Index("IDX_L2PS_PROOFS_BLOCK", ["target_block_number"])
@Index("IDX_L2PS_PROOFS_BATCH_HASH", ["l1_batch_hash"])
@Index("IDX_L2PS_PROOFS_UID_STATUS", ["l2ps_uid", "status"])
export class L2PSProof {
    /**
     * Auto-generated primary key
     */
    @PrimaryGeneratedColumn()
    id: number

    /**
     * L2PS network UID
     */
    @Column("text")
    l2ps_uid: string

    /**
     * Hash of the L2PS batch transaction on L1
     */
    @Column("text")
    l1_batch_hash: string

    /**
     * ZK Proof data (will be actual ZK proof later, for now simplified proof)
     * Structure:
     * {
     *   type: "snark" | "stark" | "placeholder",
     *   data: string (hex-encoded proof),
     *   verifier_key: string (optional),
     *   public_inputs: any[]
     * }
     */
    @Column("jsonb")
    proof: {
        type: "snark" | "stark" | "placeholder"
        data: string
        verifier_key?: string
        public_inputs: any[]
    }

    /**
     * GCR Edits to be applied to L1 state when proof is verified
     * These edits modify the main gcr_main table (L1 balances)
     */
    @Column("jsonb")
    gcr_edits: GCREdit[]

    /**
     * Accounts affected by this proof's GCR edits
     */
    @Column("simple-array")
    affected_accounts: string[]

    /**
     * Block number when this proof should be applied
     * Used for ordering and ensuring proofs are applied in correct order
     */
    @Column("integer", { nullable: true })
    target_block_number: number

    /**
     * Block number where proof was actually applied (after consensus)
     */
    @Column("integer", { nullable: true })
    applied_block_number: number

    /**
     * Proof status
     */
    @Column("text", { default: "pending" })
    status: L2PSProofStatus

    /**
     * Number of transactions included in this proof
     */
    @Column("integer", { default: 1 })
    transaction_count: number

    /**
     * Consolidated hash of all transactions in this proof
     * (Same as stored in l2ps_hashes for validator consensus)
     */
    @Column("text")
    transactions_hash: string

    /**
     * Error message if proof was rejected
     */
    @Column("text", { nullable: true })
    error_message: string

    /**
     * Timestamp when proof was created
     */
    @CreateDateColumn()
    created_at: Date

    /**
     * Timestamp when proof was applied/rejected
     */
    @Column("timestamp", { nullable: true })
    processed_at: Date
}
