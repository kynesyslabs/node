import { Repository } from "typeorm"
import Datasource from "@/model/datasource"
import { L2PSHash } from "@/model/entities/L2PSHashes"
import log from "@/utilities/logger"

/**
 * L2PS Hashes Manager
 *
 * Manages L2PS UID → hash mappings for validator consensus.
 * Validators use this to store consolidated hashes from L2PS participants
 * without ever seeing actual transaction content, preserving privacy.
 *
 * Key Features:
 * - Stores only hash mappings (privacy-preserving for validators)
 * - Updates hashes atomically (one per L2PS UID)
 * - Provides statistics for monitoring
 * - Content-blind consensus participation
 *
 * @class L2PSHashes
 */
// REVIEW: New manager for Phase 3b - Validator Hash Storage
export default class L2PSHashes {
    /** TypeORM repository for L2PS hash mappings */
    public static repo: Repository<L2PSHash> = null

    /**
     * Initialize the L2PS hashes repository
     * Must be called before using any other methods
     *
     * @throws {Error} If database connection fails
     */
    public static async init(): Promise<void> {
        try {
            const db = await Datasource.getInstance()
            this.repo = db.getDataSource().getRepository(L2PSHash)
            log.info("[L2PS Hashes] Initialized successfully")
        } catch (error: any) {
            log.error("[L2PS Hashes] Failed to initialize:", error)
            throw error
        }
    }

    /**
     * REVIEW: PR Fix - Ensure repository is initialized before use
     * @throws {Error} If repository not initialized
     */
    private static ensureInitialized(): void {
        if (!this.repo) {
            throw new Error("[L2PS Hashes] Repository not initialized. Call init() first.")
        }
    }

    /**
     * Update or create hash mapping for a L2PS network
     * Validators receive these updates via DTR relay from L2PS participants
     *
     * @param l2psUid - L2PS network identifier
     * @param hash - Consolidated hash of all transactions
     * @param txCount - Number of transactions in the hash
     * @param blockNumber - Block number for consensus ordering
     * @returns Promise resolving to success status
     *
     * @example
     * ```typescript
     * await L2PSHashes.updateHash(
     *     "network_1",
     *     "0xa1b2c3d4e5f6...",
     *     50,
     *     BigInt(12345)
     * )
     * ```
     */
    public static async updateHash(
        l2psUid: string,
        hash: string,
        txCount: number,
        blockNumber: bigint,
    ): Promise<void> {
        this.ensureInitialized()
        try {
            // Check if hash mapping already exists
            const existing = await this.repo.findOne({
                where: { l2ps_uid: l2psUid },
            })

            const hashEntry: L2PSHash = {
                l2ps_uid: l2psUid,
                hash: hash,
                transaction_count: txCount,
                block_number: blockNumber,
                timestamp: BigInt(Date.now()),
            }

            if (existing) {
                // Update existing hash mapping
                await this.repo.update(
                    { l2ps_uid: l2psUid },
                    hashEntry,
                )
                log.debug(`[L2PS Hashes] Updated hash for L2PS ${l2psUid}: ${hash.substring(0, 16)}... (${txCount} txs)`)
            } else {
                // Create new hash mapping
                await this.repo.save(hashEntry)
                log.debug(`[L2PS Hashes] Created hash for L2PS ${l2psUid}: ${hash.substring(0, 16)}... (${txCount} txs)`)
            }
        } catch (error: any) {
            log.error(`[L2PS Hashes] Failed to update hash for ${l2psUid}:`, error)
            throw error
        }
    }

    /**
     * Retrieve hash mapping for a specific L2PS network
     *
     * @param l2psUid - L2PS network identifier
     * @returns Promise resolving to hash entry or null if not found
     *
     * @example
     * ```typescript
     * const hashEntry = await L2PSHashes.getHash("network_1")
     * if (hashEntry) {
     *     console.log(`Current hash: ${hashEntry.hash}`)
     *     console.log(`Transaction count: ${hashEntry.transaction_count}`)
     * }
     * ```
     */
    public static async getHash(l2psUid: string): Promise<L2PSHash | null> {
        this.ensureInitialized()
        try {
            const entry = await this.repo.findOne({
                where: { l2ps_uid: l2psUid },
            })
            // REVIEW: PR Fix - TypeORM returns undefined, explicitly convert to null
            return entry ?? null
        } catch (error: any) {
            log.error(`[L2PS Hashes] Failed to get hash for ${l2psUid}:`, error)
            throw error
        }
    }

    /**
     * Get all L2PS hash mappings
     * Useful for monitoring and statistics
     *
     * @returns Promise resolving to array of all hash entries
     *
     * @example
     * ```typescript
     * const allHashes = await L2PSHashes.getAll()
     * console.log(`Tracking ${allHashes.length} L2PS networks`)
     * ```
     */
    public static async getAll(): Promise<L2PSHash[]> {
        this.ensureInitialized()
        try {
            const entries = await this.repo.find({
                order: { timestamp: "DESC" },
            })
            return entries
        } catch (error: any) {
            log.error("[L2PS Hashes] Failed to get all hashes:", error)
            throw error
        }
    }

    /**
     * Get statistics about L2PS hash storage
     * Provides monitoring data for validator operations
     *
     * @returns Promise resolving to statistics object
     *
     * @example
     * ```typescript
     * const stats = await L2PSHashes.getStats()
     * console.log(`Tracking ${stats.totalNetworks} L2PS networks`)
     * console.log(`Total transactions: ${stats.totalTransactions}`)
     * console.log(`Last update: ${new Date(Number(stats.lastUpdateTime))}`)
     * ```
     */
    public static async getStats(): Promise<{
        totalNetworks: number
        totalTransactions: number
        lastUpdateTime: bigint
        oldestUpdateTime: bigint
    }> {
        this.ensureInitialized()
        try {
            const allEntries = await this.getAll()

            if (allEntries.length === 0) {
                return {
                    totalNetworks: 0,
                    totalTransactions: 0,
                    lastUpdateTime: BigInt(0),
                    oldestUpdateTime: BigInt(0),
                }
            }

            // Calculate total transactions across all L2PS networks
            const totalTransactions = allEntries.reduce(
                (sum, entry) => sum + entry.transaction_count,
                0,
            )

            // Find most recent and oldest updates
            const timestamps = allEntries.map(e => e.timestamp)
            const lastUpdateTime = timestamps.reduce(
                (max, ts) => ts > max ? ts : max,
                BigInt(0),
            )
            const oldestUpdateTime = timestamps.reduce(
                (min, ts) => ts < min ? ts : min,
                BigInt(Number.MAX_SAFE_INTEGER),
            )

            return {
                totalNetworks: allEntries.length,
                totalTransactions,
                lastUpdateTime,
                oldestUpdateTime,
            }
        } catch (error: any) {
            log.error("[L2PS Hashes] Failed to get statistics:", error)
            throw error
        }
    }
}

// REVIEW: PR Fix - Removed auto-initialization to improve testability and make initialization contract explicit
// The init() method must be called explicitly before using any other methods
