/**
 * MerkleTreeManager - Global Merkle Tree for Identity Commitments
 *
 * Purpose: Manage a global Merkle tree containing all identity commitments
 *          across all providers for maximum anonymity set.
 *
 * Features:
 * - 20-level tree (supports 1M+ commitments)
 * - Poseidon hash (ZK-friendly)
 * - Persistent state in PostgreSQL
 * - Fast proof generation for users
 * - Root hash verification for validators
 */

import { IncrementalMerkleTree } from "@zk-kit/incremental-merkle-tree"
import { poseidon2 } from "poseidon-lite"
import { DataSource, Repository } from "typeorm"
import { MerkleTreeState } from "@/model/entities/GCRv2/MerkleTreeState.js"
import { IdentityCommitment } from "@/model/entities/GCRv2/IdentityCommitment.js"

export class MerkleTreeManager {
    private tree: IncrementalMerkleTree
    private dataSource: DataSource
    private stateRepo: Repository<MerkleTreeState>
    private commitmentRepo: Repository<IdentityCommitment>
    private treeId: string
    private depth: number

    /**
     * Create a new Merkle tree manager
     *
     * @param dataSource - TypeORM DataSource for database operations
     * @param depth - Tree depth (default: 20 levels = 1M+ capacity)
     * @param treeId - Tree identifier (default: "global")
     */
    constructor(dataSource: DataSource, depth = 20, treeId = "global") {
        this.dataSource = dataSource
        this.depth = depth
        this.treeId = treeId
        this.stateRepo = dataSource.getRepository(MerkleTreeState)
        this.commitmentRepo = dataSource.getRepository(IdentityCommitment)

        // Initialize empty tree with Poseidon hash
        this.tree = new IncrementalMerkleTree(poseidon2, depth, BigInt(0), 2)
    }

    /**
     * Load existing tree state from database or initialize new tree
     *
     * @returns True if loaded from database, false if initialized new
     */
    async initialize(): Promise<boolean> {
        try {
            const state = await this.stateRepo.findOne({
                where: { treeId: this.treeId },
            })

            if (state && state.treeSnapshot) {
                // REVIEW: Reconstruct tree from stored leaves
                // The @zk-kit/incremental-merkle-tree v1.1.0 library does not have import() method
                // Instead, we reconstruct the tree from leaves using the constructor
                const snapshot = state.treeSnapshot as { leaves: string[] }

                if (!snapshot.leaves || !Array.isArray(snapshot.leaves)) {
                    throw new Error("Invalid tree snapshot format: missing leaves array")
                }

                // Convert string leaves back to BigInt and reconstruct tree with poseidon2 hash
                const leaves = snapshot.leaves.map((leaf) => BigInt(leaf))
                this.tree = new IncrementalMerkleTree(poseidon2, this.depth, BigInt(0), 2, leaves)

                // Validate depth consistency
                if (this.tree.depth !== this.depth) {
                    throw new Error(
                        `Tree depth mismatch: expected ${this.depth}, got ${this.tree.depth}`,
                    )
                }

                console.log(
                    `✅ Loaded Merkle tree: ${state.leafCount} commitments, root: ${state.rootHash.slice(0, 10)}...`,
                )
                return true
            } else {
                console.log("🌱 Initialized new Merkle tree")
                return false
            }
        } catch (error) {
            console.error("❌ Failed to load Merkle tree from database:", error)
            throw error
        }
    }

    /**
     * Add a commitment to the tree
     *
     * @param commitment - Commitment hash (as string)
     * @returns Leaf index in the tree
     */
    addCommitment(commitment: string): number {
        try {
            // Check tree capacity before insertion
            const capacity = Math.pow(2, this.depth)
            if (this.tree.leaves.length >= capacity) {
                throw new Error(
                    `Merkle tree capacity reached: ${capacity} leaves (depth ${this.depth})`,
                )
            }

            const commitmentBigInt = BigInt(commitment)
            this.tree.insert(commitmentBigInt)
            const leafIndex = this.tree.leaves.length - 1
            return leafIndex
        } catch (error) {
            console.error("❌ Failed to add commitment to tree:", error)
            throw error
        }
    }

    /**
     * Get the current Merkle root
     *
     * @returns Root hash as string
     */
    getRoot(): string {
        return this.tree.root.toString()
    }

    /**
     * Get the number of commitments in the tree
     *
     * @returns Leaf count
     */
    getLeafCount(): number {
        return this.tree.leaves.length
    }

    /**
     * Generate a Merkle proof for a commitment at given leaf index
     *
     * @param leafIndex - Index of the commitment in the tree
     * @returns Merkle proof (siblings array)
     */
    generateProof(leafIndex: number): {
        siblings: string[][]
        pathIndices: number[]
        root: string
        leaf: string
    } {
        try {
            const proof = this.tree.createProof(leafIndex)

            return {
                siblings: proof.siblings.map((s) => s.map((v) => v.toString())),
                pathIndices: proof.pathIndices,
                root: proof.root.toString(),
                leaf: proof.leaf.toString(),
            }
        } catch (error) {
            console.error(`❌ Failed to generate proof for leaf ${leafIndex}:`, error)
            throw error
        }
    }

    /**
     * Get Merkle proof for a specific commitment hash
     *
     * @param commitmentHash - The commitment hash to find
     * @returns Merkle proof or null if not found
     */
    async getProofForCommitment(commitmentHash: string): Promise<{
        siblings: string[][]
        pathIndices: number[]
        root: string
        leaf: string
        leafIndex: number
    } | null> {
        try {
            // Find the commitment in the database to get its leaf index
            const commitment = await this.commitmentRepo.findOne({
                where: { commitmentHash },
            })

            if (!commitment || commitment.leafIndex === -1) {
                console.warn(`⚠️ Commitment not found: ${commitmentHash.slice(0, 10)}...`)
                return null
            }

            const proof = this.generateProof(commitment.leafIndex)
            return {
                ...proof,
                leafIndex: commitment.leafIndex,
            }
        } catch (error) {
            console.error("❌ Failed to get proof for commitment:", error)
            // REVIEW: Throw error instead of returning null to distinguish from "not found"
            throw error
        }
    }

    /**
     * Save current tree state to database
     *
     * @param blockNumber - Current block number
     * @param manager - Optional EntityManager for transactional operations
     */
    async saveToDatabase(blockNumber: number, manager?: any): Promise<void> {
        try {
            // REVIEW: Save tree leaves for reconstruction
            // The @zk-kit/incremental-merkle-tree v1.1.0 library does not have export() method
            // We store the leaves array which can be used to reconstruct the tree
            const snapshot = {
                leaves: this.tree.leaves.map((leaf) => leaf.toString()),
            }

            // REVIEW: HIGH FIX - Use transactional manager if provided to ensure atomicity
            // When called within a transaction, use the provided EntityManager
            const repo = manager ? manager.getRepository(MerkleTreeState) : this.stateRepo

            await repo.save({
                treeId: this.treeId,
                rootHash: this.getRoot(),
                blockNumber,
                leafCount: this.getLeafCount(),
                treeSnapshot: snapshot,
            })

            console.log(
                `💾 Saved Merkle tree state: ${this.getLeafCount()} leaves at block ${blockNumber}`,
            )
        } catch (error) {
            console.error("❌ Failed to save Merkle tree to database:", error)
            throw error
        }
    }

    /**
     * Verify a Merkle proof
     *
     * @param proof - Merkle proof to verify
     * @param leaf - Leaf value
     * @param root - Expected root hash
     * @returns True if proof is valid
     */
    static verifyProof(
        proof: { siblings: bigint[][]; pathIndices: number[] },
        leaf: bigint,
        root: bigint,
    ): boolean {
        try {
            // REVIEW: verifyProof accepts only one argument - the MerkleProof object
            // Include leaf and root in proof object as required by zk-kit library
            return IncrementalMerkleTree.verifyProof({ ...proof, leaf, root })
        } catch (error) {
            console.error("❌ Proof verification failed:", error)
            return false
        }
    }

    /**
     * Get tree statistics
     *
     * @returns Tree statistics object
     */
    getStats(): {
        treeId: string
        depth: number
        leafCount: number
        capacity: number
        root: string
        utilizationPercent: number
    } {
        const capacity = Math.pow(2, this.depth)
        const leafCount = this.getLeafCount()

        return {
            treeId: this.treeId,
            depth: this.depth,
            leafCount,
            capacity,
            root: this.getRoot(),
            utilizationPercent: (leafCount / capacity) * 100,
        }
    }
}
