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
    // REVIEW: PR Fix #8 - Add | null to repo type annotation for proper TypeScript type safety
    public static repo: Repository<L2PSHash> | null = null

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
    private static async ensureInitialized(): Promise<void> {
        if (!this.repo) {
            await this.init()
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
        await this.ensureInitialized()
        try {
            // REVIEW: PR Fix #11 - Use atomic upsert to prevent race condition
            // Previous code: check-then-act pattern allowed concurrent inserts to cause conflicts
            // Solution: Use TypeORM's save() which performs atomic upsert when entity has primary key

            const hashEntry: L2PSHash = {
                l2ps_uid: l2psUid,
                hash: hash,
                transaction_count: txCount,
                block_number: blockNumber.toString(),
                timestamp: Date.now().toString(),
            }

            // TypeORM's save() performs atomic upsert when entity with primary key exists
            // This prevents race conditions from concurrent updates
            // REVIEW: PR Fix #9 - Add non-null assertion for type safety
            await this.repo!.save(hashEntry)

            log.debug(`[L2PS Hashes] Upserted hash for L2PS ${l2psUid}: ${hash.substring(0, 16)}... (${txCount} txs)`)
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
        await this.ensureInitialized()
        try {
            // REVIEW: PR Fix #9 - Add non-null assertion for type safety
            const entry = await this.repo!.findOne({
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
     * @param limit - Optional maximum number of entries to return
     * @param offset - Optional number of entries to skip (for pagination)
     * @returns Promise resolving to array of hash entries
     *
     * @example
     * ```typescript
     * const allHashes = await L2PSHashes.getAll()
     * console.log(`Tracking ${allHashes.length} L2PS networks`)
     *
     * // With pagination
     * const page1 = await L2PSHashes.getAll(10, 0)  // First 10 entries
     * const page2 = await L2PSHashes.getAll(10, 10) // Next 10 entries
     * ```
     */
    public static async getAll(
        limit?: number,
        offset?: number,
    ): Promise<L2PSHash[]> {
        await this.ensureInitialized()
        try {
            // REVIEW: PR Fix #8 - Add pagination support and type safety
            const entries = await this.repo!.find({
                order: { timestamp: "DESC" },
                ...(limit && { take: limit }),
                ...(offset && { skip: offset }),
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
        await this.ensureInitialized()
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

            // Find most recent and oldest updates (timestamps are stored as strings)
            const timestamps = allEntries.map(e => BigInt(e.timestamp))
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
