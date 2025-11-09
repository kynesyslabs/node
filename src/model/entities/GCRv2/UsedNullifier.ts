import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from "typeorm"

/**
 * UsedNullifier Entity
 *
 * Prevents double-attestation by tracking used nullifiers.
 * Each nullifier is unique per (provider, context) combination.
 *
 * Nullifier = Poseidon(provider_id, context)
 *
 * Once a nullifier is used, it cannot be reused, ensuring that each identity
 * can only attest once per context (e.g., one vote per poll, one claim per airdrop).
 */
@Entity("used_nullifiers")
@Index("idx_nullifier_hash", ["nullifierHash"])
@Index("idx_nullifier_block", ["blockNumber"])
export class UsedNullifier {
    /**
     * Primary key: Hash of the nullifier
     * Format: Hex string (64 characters)
     * Example: "0x5e6f7g8h..."
     */
    @PrimaryColumn({ type: "text", name: "nullifier_hash" })
    nullifierHash: string

    /**
     * Block number when this nullifier was used
     */
    @Column({ type: "integer", name: "block_number" })
    blockNumber: number

    /**
     * Transaction hash that used this nullifier
     */
    @Column({ type: "text", name: "transaction_hash" })
    transactionHash: string

    /**
     * Timestamp when nullifier was used
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
