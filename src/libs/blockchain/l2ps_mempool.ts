import { FindManyOptions, Repository } from "typeorm"
import Datasource from "@/model/datasource"
import { L2PSMempoolTx } from "@/model/entities/L2PSMempool"
import { L2PSTransaction } from "@kynesyslabs/demosdk/types"
import { Hashing } from "@kynesyslabs/demosdk/encryption"
import Chain from "./chain"
import SecretaryManager from "../consensus/v2/types/secretaryManager"
import log from "@/utilities/logger"

/**
 * L2PS Mempool Manager
 * 
 * Manages L2PS (Layer 2 Privacy Subnets) transactions in a separate mempool
 * from the main validator mempool. This class handles encrypted L2PS transactions,
 * generates consolidated hashes for validator relay, and maintains L2PS-specific
 * transaction state without exposing decrypted content.
 * 
 * Key Features:
 * - Stores only encrypted L2PS transactions (privacy-preserving)
 * - Generates deterministic consolidated hashes per L2PS UID
 * - Supports block-specific and cross-block hash generation
 * - Prevents duplicate transaction processing
 * - Follows main mempool patterns for consistency
 */
export default class L2PSMempool {
    /** TypeORM repository for L2PS mempool transactions */
    // REVIEW: PR Fix - Added | null to type annotation for type safety
    public static repo: Repository<L2PSMempoolTx> | null = null

    /**
     * Initialize the L2PS mempool repository
     * Must be called before using any other methods
     * 
     * @throws {Error} If database connection fails
     */
    public static async init(): Promise<void> {
        try {
            const db = await Datasource.getInstance()
            this.repo = db.getDataSource().getRepository(L2PSMempoolTx)
            log.info("[L2PS Mempool] Initialized successfully")
        } catch (error: any) {
            log.error("[L2PS Mempool] Failed to initialize:", error)
            throw error
        }
    }

    /**
     * Add L2PS transaction to mempool after successful decryption
     * 
     * @param l2psUid - L2PS network identifier
     * @param encryptedTx - Encrypted L2PS transaction object
     * @param originalHash - Hash of original transaction before encryption
     * @param status - Transaction status (default: "processed")
     * @returns Promise resolving to success status and optional error message
     * 
     * @example
     * ```typescript
     * const result = await L2PSMempool.addTransaction(
     *     "network_1", 
     *     encryptedTransaction, 
     *     "0xa1b2c3d4...",
     *     "processed"
     * )
     * if (!result.success) {
     *     console.error("Failed to add:", result.error)
     * }
     * ```
     */
    public static async addTransaction(
        l2psUid: string, 
        encryptedTx: L2PSTransaction, 
        originalHash: string,
        status = "processed",
    ): Promise<{ success: boolean; error?: string }> {
        try {
            // Check if original transaction already processed (duplicate detection)
            const alreadyExists = await this.existsByOriginalHash(originalHash)
            if (alreadyExists) {
                return {
                    success: false,
                    error: "Transaction already processed",
                }
            }

            // Check if encrypted hash already exists
            const encryptedExists = await this.repo.exists({ where: { hash: encryptedTx.hash } })
            if (encryptedExists) {
                return {
                    success: false,
                    error: "Encrypted transaction already in L2PS mempool",
                }
            }

            // Determine block number (following main mempool pattern)
            let blockNumber: number
            const manager = SecretaryManager.getInstance()

            if (manager.shard?.blockRef) {
                blockNumber = manager.shard.blockRef + 1
            } else {
                blockNumber = (await Chain.getLastBlockNumber()) + 1
            }

            // Save to L2PS mempool
            await this.repo.save({
                hash: encryptedTx.hash,
                l2ps_uid: l2psUid,
                original_hash: originalHash,
                encrypted_tx: encryptedTx,
                status: status,
                timestamp: BigInt(Date.now()),
                block_number: blockNumber,
            })

            log.info(`[L2PS Mempool] Added transaction ${encryptedTx.hash} for L2PS ${l2psUid}`)
            return { success: true }

        } catch (error: any) {
            log.error("[L2PS Mempool] Error adding transaction:", error)
            return {
                success: false,
                error: error.message || "Unknown error",
            }
        }
    }

    /**
     * Get all L2PS transactions for a specific UID, optionally filtered by status
     * 
     * @param l2psUid - L2PS network identifier
     * @param status - Optional status filter ("pending", "processed", "failed")
     * @returns Promise resolving to array of L2PS mempool transactions
     * 
     * @example
     * ```typescript
     * // Get all processed transactions for network_1
     * const txs = await L2PSMempool.getByUID("network_1", "processed")
     * ```
     */
    public static async getByUID(l2psUid: string, status?: string): Promise<L2PSMempoolTx[]> {
        try {
            const options: FindManyOptions<L2PSMempoolTx> = {
                where: { l2ps_uid: l2psUid },
                order: {
                    timestamp: "ASC",
                    hash: "ASC",
                },
            }

            if (status) {
                options.where = { ...options.where, status }
            }

            return await this.repo.find(options)
        } catch (error: any) {
            log.error(`[L2PS Mempool] Error getting transactions for UID ${l2psUid}:`, error)
            return []
        }
    }

    /**
     * Generate consolidated hash for L2PS UID from specific block or all blocks
     * 
     * This method creates a deterministic hash representing all L2PS transactions
     * for a given UID. The hash is used for validator relay via DTR, allowing
     * validators to track L2PS network state without seeing transaction content.
     * 
     * @param l2psUid - L2PS network identifier
     * @param blockNumber - Optional block number filter (default: all blocks)
     * @returns Promise resolving to deterministic consolidated hash
     * 
     * @example
     * ```typescript
     * // Hash all transactions for network_1
     * const allHash = await L2PSMempool.getHashForL2PS("network_1")
     * 
     * // Hash only transactions in block 12345
     * const blockHash = await L2PSMempool.getHashForL2PS("network_1", 12345)
     * ```
     */
    public static async getHashForL2PS(l2psUid: string, blockNumber?: number): Promise<string> {
        try {
            const options: FindManyOptions<L2PSMempoolTx> = {
                where: { 
                    l2ps_uid: l2psUid,
                    status: "processed",  // Only include successfully processed transactions
                },
                order: {
                    timestamp: "ASC",
                    hash: "ASC",
                },
            }

            // Add block filter if specified
            if (blockNumber !== undefined) {
                options.where = { ...options.where, block_number: blockNumber }
            }

            const transactions = await this.repo.find(options)
            
            if (transactions.length === 0) {
                // Return deterministic empty hash
                const suffix = blockNumber !== undefined ? `_BLOCK_${blockNumber}` : "_ALL"
                return Hashing.sha256(`L2PS_EMPTY_${l2psUid}${suffix}`)
            }

            // Sort hashes for deterministic output
            const sortedHashes = transactions
                .map(tx => tx.hash)
                .sort()

            // Create consolidated hash: UID + block info + count + all hashes
            const blockSuffix = blockNumber !== undefined ? `_BLOCK_${blockNumber}` : "_ALL"
            const hashInput = `L2PS_${l2psUid}${blockSuffix}:${sortedHashes.length}:${sortedHashes.join(",")}`
            
            const consolidatedHash = Hashing.sha256(hashInput)
            
            log.debug(`[L2PS Mempool] Generated hash for ${l2psUid}${blockSuffix}: ${consolidatedHash} (${sortedHashes.length} txs)`)
            return consolidatedHash

        } catch (error: any) {
            log.error(`[L2PS Mempool] Error generating hash for UID ${l2psUid}, block ${blockNumber}:`, error)
            // REVIEW: PR Fix #5 - Return truly deterministic error hash (removed Date.now() for reproducibility)
            // Algorithm: SHA256("L2PS_ERROR_" + l2psUid + blockSuffix)
            // This ensures the same error conditions always produce the same hash
            const blockSuffix = blockNumber !== undefined ? `_BLOCK_${blockNumber}` : "_ALL"
            return Hashing.sha256(`L2PS_ERROR_${l2psUid}${blockSuffix}`)
        }
    }

    /**
     * Legacy method for backward compatibility
     * @deprecated Use getHashForL2PS() instead
     */
    public static async getConsolidatedHash(l2psUid: string): Promise<string> {
        return this.getHashForL2PS(l2psUid)
    }

    /**
     * Update transaction status and timestamp
     * 
     * @param hash - Transaction hash to update
     * @param status - New status ("pending", "processed", "failed")
     * @returns Promise resolving to true if updated, false otherwise
     */
    public static async updateStatus(hash: string, status: string): Promise<boolean> {
        try {
            const result = await this.repo.update(
                { hash },
                { status, timestamp: BigInt(Date.now()) },
            )
            
            const updated = result.affected > 0
            if (updated) {
                log.info(`[L2PS Mempool] Updated status of ${hash} to ${status}`)
            }
            return updated

        } catch (error: any) {
            log.error(`[L2PS Mempool] Error updating status for ${hash}:`, error)
            return false
        }
    }

    /**
     * Check if a transaction with the given original hash already exists
     * Used for duplicate detection during transaction processing
     * 
     * @param originalHash - Original transaction hash before encryption
     * @returns Promise resolving to true if exists, false otherwise
     */
    public static async existsByOriginalHash(originalHash: string): Promise<boolean> {
        try {
            return await this.repo.exists({ where: { original_hash: originalHash } })
        } catch (error: any) {
            log.error(`[L2PS Mempool] Error checking original hash ${originalHash}:`, error)
            // REVIEW: PR Fix #3 - Throw error instead of returning false to prevent duplicates on DB errors
            throw error
        }
    }

    /**
     * Check if a transaction with the given encrypted hash exists
     * 
     * @param hash - Encrypted transaction hash
     * @returns Promise resolving to true if exists, false otherwise
     */
    public static async existsByHash(hash: string): Promise<boolean> {
        try {
            return await this.repo.exists({ where: { hash } })
        } catch (error: any) {
            log.error(`[L2PS Mempool] Error checking hash ${hash}:`, error)
            // REVIEW: PR Fix #3 - Throw error instead of returning false to prevent duplicates on DB errors
            throw error
        }
    }

    /**
     * Get a specific transaction by its encrypted hash
     * 
     * @param hash - Encrypted transaction hash
     * @returns Promise resolving to transaction or null if not found
     */
    public static async getByHash(hash: string): Promise<L2PSMempoolTx | null> {
        try {
            return await this.repo.findOne({ where: { hash } })
        } catch (error: any) {
            log.error(`[L2PS Mempool] Error getting transaction ${hash}:`, error)
            return null
        }
    }

    /**
     * Clean up old processed transactions
     * 
     * @param olderThanMs - Remove transactions older than this many milliseconds
     * @returns Promise resolving to number of transactions deleted
     * 
     * @example
     * ```typescript
     * // Clean up transactions older than 24 hours
     * const deleted = await L2PSMempool.cleanup(24 * 60 * 60 * 1000)
     * console.log(`Cleaned up ${deleted} old transactions`)
     * ```
     */
    public static async cleanup(olderThanMs: number): Promise<number> {
        try {
            const cutoffTimestamp = BigInt(Date.now() - olderThanMs)
            
            const result = await this.repo
                .createQueryBuilder()
                .delete()
                .from(L2PSMempoolTx)
                .where("timestamp < :cutoff", { cutoff: cutoffTimestamp.toString() })
                .andWhere("status = :status", { status: "processed" })
                .execute()

            const deletedCount = result.affected || 0
            if (deletedCount > 0) {
                log.info(`[L2PS Mempool] Cleaned up ${deletedCount} old transactions`)
            }
            return deletedCount

        } catch (error: any) {
            log.error("[L2PS Mempool] Error during cleanup:", error)
            return 0
        }
    }

    /**
     * Get comprehensive statistics about the L2PS mempool
     * 
     * @returns Promise resolving to mempool statistics
     * 
     * @example
     * ```typescript
     * const stats = await L2PSMempool.getStats()
     * console.log(`Total: ${stats.totalTransactions}`)
     * console.log(`By UID:`, stats.transactionsByUID)
     * console.log(`By Status:`, stats.transactionsByStatus)
     * ```
     */
    public static async getStats(): Promise<{
        totalTransactions: number;
        transactionsByUID: Record<string, number>;
        transactionsByStatus: Record<string, number>;
    }> {
        try {
            const totalTransactions = await this.repo.count()
            
            // Get transactions by UID
            const byUID = await this.repo
                .createQueryBuilder("tx")
                .select("tx.l2ps_uid", "l2ps_uid")
                .addSelect("COUNT(*)", "count")
                .groupBy("tx.l2ps_uid")
                .getRawMany()

            const transactionsByUID = byUID.reduce((acc, row) => {
                acc[row.l2ps_uid] = parseInt(row.count)
                return acc
            }, {})

            // Get transactions by status
            const byStatus = await this.repo
                .createQueryBuilder("tx")
                .select("tx.status", "status")
                .addSelect("COUNT(*)", "count")
                .groupBy("tx.status")
                .getRawMany()

            const transactionsByStatus = byStatus.reduce((acc, row) => {
                acc[row.status] = parseInt(row.count)
                return acc
            }, {})

            return {
                totalTransactions,
                transactionsByUID,
                transactionsByStatus,
            }

        } catch (error: any) {
            log.error("[L2PS Mempool] Error getting stats:", error)
            return {
                totalTransactions: 0,
                transactionsByUID: {},
                transactionsByStatus: {},       
            }
        }
    }
}

// Initialize the mempool on import
L2PSMempool.init().catch(error => {
    log.error("[L2PS Mempool] Failed to initialize during import:", error)
})