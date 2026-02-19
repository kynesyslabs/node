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
     * Format: Hex string (64 hex digits + "0x" prefix = 66 characters total)
     * Example: "0x5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f"
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
     * Timestamp when nullifier was used (milliseconds since epoch)
     * REVIEW: Using bigint to safely store Date.now() values (JavaScript safe up to 2^53)
     * TypeORM bigint is stored as string in DB but transformed to/from number in TypeScript
     */
    @Column({
        type: "bigint",
        name: "timestamp",
        transformer: {
            to: (value: number) => value.toString(),
            from: (value: string) => parseInt(value, 10),
        },
    })
    timestamp: number

    /**
     * Auto-generated creation timestamp
     */
    @CreateDateColumn({ name: "created_at" })
    createdAt: Date
}
