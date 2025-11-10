/**
 * Merkle Tree Update After Block Commit
 *
 * This utility updates the global Merkle tree with all identity commitments
 * that were added in the committed block.
 *
 * Called after each block is successfully committed to the blockchain.
 */

import { DataSource } from "typeorm"
import { IdentityCommitment } from "@/model/entities/GCRv2/IdentityCommitment"
import { MerkleTreeState } from "@/model/entities/GCRv2/MerkleTreeState"
import { MerkleTreeManager } from "./MerkleTreeManager"
import log from "@/utilities/logger"

/**
 * Update Merkle tree with commitments from a specific block
 *
 * @param dataSource - TypeORM DataSource
 * @param blockNumber - Block number that was just committed
 * @returns Number of commitments added to the tree
 */
export async function updateMerkleTreeAfterBlock(
    dataSource: DataSource,
    blockNumber: number,
): Promise<number> {
    try {
        const commitmentRepo = dataSource.getRepository(IdentityCommitment)
        const merkleStateRepo = dataSource.getRepository(MerkleTreeState)

        // Find all commitments from this block that haven't been added to tree yet
        // (leafIndex === -1 means not yet in tree)
        const newCommitments = await commitmentRepo.find({
            where: {
                blockNumber: blockNumber,
                leafIndex: -1,
            },
            order: {
                timestamp: "ASC", // Process in deterministic order
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
        const merkleManager = new MerkleTreeManager(dataSource, 20, "global")
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

        // Batch save all updated commitments
        await commitmentRepo.save(newCommitments)

        // Save updated Merkle tree state
        await merkleManager.saveToDatabase(blockNumber)

        const stats = merkleManager.getStats()
        log.info(
            `Merkle tree updated for block ${blockNumber}: ${stats.totalLeaves} total leaves, root: ${stats.currentRoot.slice(0, 10)}...`,
        )

        return newCommitments.length
    } catch (error) {
        log.error(`Failed to update Merkle tree for block ${blockNumber}:`, error)
        throw error
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
        where: { treeId: "global" },
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
                    treeId: "global",
                    blockNumber: targetBlockNumber,
                },
            })

            if (!targetState) {
                throw new Error(
                    `No Merkle tree state found for block ${targetBlockNumber}`,
                )
            }

            // Reset leaf indices for commitments after target block (within transaction)
            await commitmentRepo
                .createQueryBuilder()
                .update(IdentityCommitment)
                .set({ leafIndex: -1 })
                .where("block_number > :blockNumber", {
                    blockNumber: targetBlockNumber,
                })
                .execute()

            // Delete tree states after target block (within transaction)
            await merkleStateRepo
                .createQueryBuilder()
                .delete()
                .where("block_number > :blockNumber", {
                    blockNumber: targetBlockNumber,
                })
                .andWhere("tree_id = :treeId", { treeId: "global" })
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
