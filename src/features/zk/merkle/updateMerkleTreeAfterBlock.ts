/**
 * Merkle Tree Update After Block Commit
 *
 * This utility updates the global Merkle tree with all identity commitments
 * that were added in the committed block.
 *
 * Called after each block is successfully committed to the blockchain.
 */

import { DataSource, EntityManager } from "typeorm"
import { IdentityCommitment } from "@/model/entities/GCRv2/IdentityCommitment"
import { MerkleTreeState } from "@/model/entities/GCRv2/MerkleTreeState"
import { MerkleTreeManager } from "./MerkleTreeManager"
import log from "@/utilities/logger"

// Global Merkle tree identifier
const GLOBAL_TREE_ID = "global"

/**
 * Update Merkle tree with commitments from a specific block
 *
 * REVIEW: Transaction wrapper added to ensure atomicity
 * All tree operations (fetch, add, save) must succeed or fail together
 *
 * @param dataSource - TypeORM DataSource
 * @param blockNumber - Block number that was just committed
 * @param manager - Optional EntityManager for transactional operations
 * @returns Number of commitments added to the tree
 */
export async function updateMerkleTreeAfterBlock(
    dataSource: DataSource,
    blockNumber: number,
    manager?: EntityManager,
): Promise<number> {
    // REVIEW: If called with a manager, use it; otherwise create own transaction
    if (manager) {
        return await updateMerkleTreeWithManager(manager, dataSource, blockNumber)
    }

    // Standalone call - wrap in own transaction
    return await dataSource.transaction(async (transactionalEntityManager) => {
        return await updateMerkleTreeWithManager(transactionalEntityManager, dataSource, blockNumber)
    })
}

/**
 * Internal implementation that uses a specific EntityManager
 * This ensures all database operations are part of the same transaction
 */
async function updateMerkleTreeWithManager(
    manager: EntityManager,
    dataSource: DataSource,
    blockNumber: number,
): Promise<number> {
    try {
        const commitmentRepo = manager.getRepository(IdentityCommitment)
        const merkleStateRepo = manager.getRepository(MerkleTreeState)

        // Find all commitments from this block that haven't been added to tree yet
        // (leafIndex === -1 means not yet in tree)
        const newCommitments = await commitmentRepo.find({
            where: {
                blockNumber: blockNumber,
                leafIndex: -1,
            },
            order: {
                timestamp: "ASC", // Process in deterministic order
                commitmentHash: "ASC", // REVIEW: Break timestamp ties deterministically
            },
        })

        if (newCommitments.length === 0) {
            log.debug(
                `No new ZK commitments to add to Merkle tree for block ${blockNumber}`,
            )
            return 0
        }

        log.info(
            `Adding ${newCommitments.length} ZK commitment(s) to Merkle tree for block ${blockNumber}`,
        )

        // Initialize Merkle tree manager
        const merkleManager = new MerkleTreeManager(dataSource, 20, GLOBAL_TREE_ID)
        await merkleManager.initialize()

        // Add each commitment to the tree and update the leaf index
        for (const commitment of newCommitments) {
            const leafIndex = merkleManager.addCommitment(
                commitment.commitmentHash,
            )

            // Update commitment with its leaf index (in-memory)
            commitment.leafIndex = leafIndex

            log.debug(
                `  ✅ Commitment ${commitment.commitmentHash.slice(0, 10)}... added at leaf index ${leafIndex}`,
            )
        }

        // REVIEW: Batch save all updated commitments within transaction
        await commitmentRepo.save(newCommitments)

        // REVIEW: HIGH FIX - Pass EntityManager to ensure Merkle tree save is within transaction
        // saveToDatabase() will use the transactional manager, ensuring atomicity
        await merkleManager.saveToDatabase(blockNumber, manager)

        const stats = merkleManager.getStats()
        log.info(
            `Merkle tree updated for block ${blockNumber}: ${stats.leafCount} total leaves, root: ${stats.root.slice(0, 10)}...`,
        )

        return newCommitments.length
    } catch (error) {
        log.error(`Failed to update Merkle tree for block ${blockNumber}:`, error)
        throw error // Transaction will rollback
    }
}

/**
 * Get current Merkle tree statistics
 *
 * @param dataSource - TypeORM DataSource
 * @returns Current tree state or null if tree not initialized
 */
export async function getCurrentMerkleTreeState(
    dataSource: DataSource,
): Promise<MerkleTreeState | null> {
    const merkleStateRepo = dataSource.getRepository(MerkleTreeState)

    const currentState = await merkleStateRepo.findOne({
        where: { treeId: GLOBAL_TREE_ID },
        order: { blockNumber: "DESC" },
    })

    return currentState
}

/**
 * Rollback Merkle tree to a previous block
 *
 * @param dataSource - TypeORM DataSource
 * @param targetBlockNumber - Block number to rollback to
 */
export async function rollbackMerkleTreeToBlock(
    dataSource: DataSource,
    targetBlockNumber: number,
): Promise<void> {
    // REVIEW: Wrapped in transaction to prevent partial rollback corruption
    await dataSource.transaction(async (transactionalEntityManager) => {
        try {
            const commitmentRepo = transactionalEntityManager.getRepository(IdentityCommitment)
            const merkleStateRepo = transactionalEntityManager.getRepository(MerkleTreeState)

            log.info(
                `Rolling back Merkle tree to block ${targetBlockNumber}`,
            )

            // Find the target tree state
            const targetState = await merkleStateRepo.findOne({
                where: {
                    treeId: GLOBAL_TREE_ID,
                    blockNumber: targetBlockNumber,
                },
            })

            if (!targetState) {
                throw new Error(
                    `No Merkle tree state found for block ${targetBlockNumber}`,
                )
            }

            // REVIEW: HIGH FIX - Use entity property names with alias, not column names
            // TypeORM QueryBuilder requires property names (blockNumber) not DB columns (block_number)
            // NOTE: IdentityCommitment doesn't have treeId - all commitments are in the global tree
            // Reset leaf indices for commitments after target block (within transaction)
            await commitmentRepo
                .createQueryBuilder("commitment")
                .update(IdentityCommitment)
                .set({ leafIndex: -1 })
                .where("commitment.blockNumber > :blockNumber", {
                    blockNumber: targetBlockNumber,
                })
                .execute()

            // REVIEW: HIGH FIX - Use entity property names, not column names
            // Delete tree states after target block (within transaction)
            await merkleStateRepo
                .createQueryBuilder()
                .delete()
                .where("blockNumber > :blockNumber", {
                    blockNumber: targetBlockNumber,
                })
                .andWhere("treeId = :treeId", { treeId: GLOBAL_TREE_ID })
                .execute()

            log.info(
                `Merkle tree rolled back to block ${targetBlockNumber}`,
            )
        } catch (error) {
            log.error(
                `Failed to rollback Merkle tree to block ${targetBlockNumber}:`,
                error,
            )
            throw error // Transaction will auto-rollback on throw
        }
    })
}
