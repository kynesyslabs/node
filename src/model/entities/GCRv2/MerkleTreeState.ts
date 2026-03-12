import { Column, Entity, Index, PrimaryColumn, UpdateDateColumn } from "typeorm"

/**
 * MerkleTreeState Entity
 *
 * Stores the current state of the Merkle tree containing all identity commitments.
 * The tree is rebuilt deterministically after each block that contains commitment transactions.
 *
 * Tree structure:
 * - Depth: 20 levels (supports 1,048,576 commitments)
 * - Hash function: Poseidon (ZK-friendly)
 * - Arity: 2 (binary tree)
 */
@Entity("merkle_tree_state")
@Index("idx_merkle_tree_id", ["treeId"])
@Index("idx_merkle_block", ["blockNumber"])
export class MerkleTreeState {
    /**
     * Primary key: Tree identifier
     * Use 'global' for the unified tree containing all providers
     * Can use provider-specific IDs if needed (e.g., 'github', 'telegram')
     */
    @PrimaryColumn({ type: "text", name: "tree_id" })
    treeId: string

    /**
     * Current Merkle root hash
     * This is the public value used in ZK proofs
     * Format: Hex string representing the root node
     */
    @Column({ type: "text", name: "root_hash" })
    rootHash: string

    /**
     * Block number when this tree state was last updated
     */
    @Column({ type: "integer", name: "block_number" })
    blockNumber: number

    /**
     * Number of leaves (commitments) in the tree
     */
    @Column({ type: "integer", name: "leaf_count", default: 0 })
    leafCount: number

    /**
     * Serialized tree state for fast restoration
     * Contains the incremental Merkle tree structure exported from @zk-kit/incremental-merkle-tree
     * Allows quick tree restoration without rebuilding from all commitments
     *
     * Structure (example):
     * {
     *   depth: 20,
     *   arity: 2,
     *   leaves: [...],
     *   zeroes: [...],
     *   root: "..."
     * }
     */
    @Column({ type: "jsonb", name: "tree_snapshot" })
    treeSnapshot: object

    /**
     * Auto-updated timestamp of last modification
     */
    @UpdateDateColumn({ name: "updated_at" })
    updatedAt: Date
}
