import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from "typeorm"

/**
 * IdentityCommitment Entity
 *
 * Stores ZK-SNARK identity commitments in an append-only log.
 * Each commitment represents a user's cryptographic claim to a provider identity
 * without revealing which specific account.
 *
 * Commitment = Poseidon(provider_id, secret)
 */
@Entity("identity_commitments")
@Index("idx_commitment_hash", ["commitmentHash"])
@Index("idx_commitment_provider", ["provider"])
@Index("idx_commitment_block", ["blockNumber"])
@Index("idx_commitment_leaf", ["leafIndex"])
export class IdentityCommitment {
    /**
     * Primary key: Hash of the commitment
     * Format: Hex string (64 characters)
     * Example: "0x1a2b3c4d..."
     */
    @PrimaryColumn({ type: "text", name: "commitment_hash" })
    commitmentHash: string

    /**
     * Position in the Merkle tree
     * Set to -1 when first created, updated during tree rebuild
     */
    @Column({ type: "integer", name: "leaf_index", default: -1 })
    leafIndex: number

    /**
     * Provider type (github, telegram, discord, twitter, etc.)
     * Used for categorization and analytics only
     */
    @Column({ type: "text", name: "provider" })
    provider: string

    /**
     * Block number when this commitment was included
     */
    @Column({ type: "integer", name: "block_number" })
    blockNumber: number

    /**
     * Transaction hash that created this commitment
     */
    @Column({ type: "text", name: "transaction_hash" })
    transactionHash: string

    /**
     * Timestamp when commitment was created
     * Stored as bigint to support large timestamps
     */
    @Column({ type: "bigint", name: "timestamp" })
    timestamp: number

    /**
     * Auto-generated creation timestamp
     */
    @CreateDateColumn({ name: "created_at" })
    createdAt: Date
}
