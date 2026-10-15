import { FindManyOptions, In, Repository } from "typeorm"
import Datasource from "@/model/datasource"
import { L2PSMempoolTx } from "@/model/entities/L2PSMempool"
import type { L2PSTransaction, GCREdit } from "@kynesyslabs/demosdk/types"
import { Hashing } from "@kynesyslabs/demosdk/encryption"
import forge from "node-forge"
import { isValidL2PSTxHash } from "@/libs/l2ps/txHash"
import Chain from "./chain"
import SecretaryManager from "../consensus/v2/types/secretaryManager"
import log from "@/utilities/logger"

/**
 * L2PS Transaction Status Constants
 * 
 * Lifecycle: pending → processed → executed → batched → confirmed → (deleted)
 *            pending → processed → failed (on execution error)
 */
export const L2PS_STATUS = {
    /** Transaction received but not yet validated/decrypted */
    PENDING: "pending",
    /** Transaction decrypted and validated, ready for execution */
    PROCESSED: "processed",
    /** Transaction successfully executed within L2PS network */
    EXECUTED: "executed",
    /** Transaction execution failed (invalid nonce, insufficient balance, etc.) */
    FAILED: "failed",
    /** Transaction included in a batch, awaiting block confirmation */
    BATCHED: "batched",
    /** Batch containing this transaction has been included in a block */
    CONFIRMED: "confirmed",
} as const

export type L2PSStatus = typeof L2PS_STATUS[keyof typeof L2PS_STATUS]

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
/** Hashes read per query when the consolidated digest is computed. */
const HASH_PAGE_SIZE = 5000

export default class L2PSMempool {
    /** TypeORM repository for L2PS mempool transactions */
    public static repo: Repository<L2PSMempoolTx> | null = null

    /** Promise lock for lazy initialization to prevent race conditions */
    private static initPromise: Promise<void> | null = null

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
        } catch (error) {
            log.error("[L2PS Mempool] Failed to initialize:", error)
            throw error
        }
    }

    /**
     * Ensure repository is initialized before use (lazy initialization with locking)
     * @throws {Error} If initialization fails
     */
    private static async ensureInitialized(): Promise<void> {
        if (this.repo) return

        this.initPromise ??= this.init().catch((error) => {
            this.initPromise = null  // Clear promise on failure
            throw error
        })

        await this.initPromise
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
        // The one place every insert passes through, so a key the digest could
        // not order the way it was defined never reaches the table.
        if (!isValidL2PSTxHash(encryptedTx?.hash)) {
            return { success: false, error: "Invalid transaction hash: expected 64 lower-case hex characters" }
        }

        try {
            await this.ensureInitialized()

            // Check if original transaction already processed (duplicate detection)
            const alreadyExists = await this.existsByOriginalHash(originalHash)
            if (alreadyExists) {
                return {
                    success: false,
                    error: "Transaction already processed",
                }
            }

            // Check if encrypted hash already exists
            // Use existsByHash() instead of direct repo access for consistent error handling
            const encryptedExists = await this.existsByHash(encryptedTx.hash)
            if (encryptedExists) {
                return {
                    success: false,
                    error: "Encrypted transaction already in L2PS mempool",
                }
            }

            // Determine block number
            const { blockNumber, error } = await this.determineBlockNumber()
            if (error || blockNumber === undefined) {
                return { success: false, error }
            }

            // Save with retries
            return await this.saveTransactionWithRetry(l2psUid, encryptedTx, originalHash, blockNumber, status)

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error)
            log.error("[L2PS Mempool] Error adding transaction:", error)
            return {
                success: false,
                error: errorMsg || "Unknown error",
            }
        }
    }

    private static async determineBlockNumber(): Promise<{ blockNumber?: number; error?: string }> {
        // Determine block number (following main mempool pattern)
        let blockNumber: number
        const manager = SecretaryManager.getInstance()
        const shardBlockRef = manager?.shard?.blockRef

        if (typeof shardBlockRef === "number" && shardBlockRef >= 0) {
            blockNumber = shardBlockRef + 1
        } else {
            const lastBlockNumber = await Chain.getLastBlockNumber()
            // Validate lastBlockNumber is a valid positive number
            if (typeof lastBlockNumber !== "number" || lastBlockNumber < 0) {
                return {
                    error: `Invalid last block number: ${lastBlockNumber}`,
                }
            }
            blockNumber = lastBlockNumber + 1
        }

        // Additional safety check for final blockNumber
        if (!Number.isFinite(blockNumber) || blockNumber <= 0) {
            return {
                error: `Calculated invalid block number: ${blockNumber}`,
            }
        }
        return { blockNumber }
    }

    private static async saveTransactionWithRetry(
        l2psUid: string,
        encryptedTx: L2PSTransaction,
        originalHash: string,
        blockNumber: number,
        status: string,
    ): Promise<{ success: boolean; error?: string }> {
        // Atomic sequence allocation with retries to resolve race conditions
        let retries = 3
        while (retries > 0) {
            try {
                await this.ensureInitialized()
                const result = await this.repo!.manager.transaction(async (transactionalEntityManager) => {
                    // Get next sequence number inside transaction with lock to serialize allocation
                    const sequenceNumber = await (this as any).getNextSequenceNumber(l2psUid, transactionalEntityManager)

                    // Save inside transaction
                    await transactionalEntityManager.save(L2PSMempoolTx, {
                        hash: encryptedTx.hash,
                        l2ps_uid: l2psUid,
                        sequence_number: sequenceNumber.toString(),
                        original_hash: originalHash,
                        encrypted_tx: encryptedTx,
                        status: status,
                        timestamp: Date.now().toString(),
                        block_number: blockNumber,
                    })

                    return { sequenceNumber }
                })

                log.info(`[L2PS Mempool] Added transaction ${encryptedTx.hash} (seq: ${result.sequenceNumber}) for L2PS ${l2psUid}`)
                return { success: true }

            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error)
                const errorCode = (error as Record<string, unknown>)?.code
                // Check for unique constraint violation (Postgres error code 23505)
                const isUniqueViolation = errorCode === "23505" ||
                    errorMsg?.includes("UQ_L2PS_UID_SEQUENCE") ||
                    errorMsg?.includes("unique constraint")

                if (isUniqueViolation && retries > 1) {
                    retries--
                    log.warning(`[L2PS Mempool] Sequence collision for ${l2psUid}, retrying (${retries} attempts left)...`)
                    // Jittered backoff to let other transactions complete
                    await new Promise(resolve => setTimeout(resolve, Math.random() * 50 + 10))
                    continue
                }

                log.error("[L2PS Mempool] Error adding transaction:", error)
                return {
                    success: false,
                    error: errorMsg || "Unknown error",
                }
            }
        }

        return { success: false, error: "Maximum retries exceeded for sequence allocation" }
    }

    /**
     * Get next sequence number for a specific L2PS network
     * Auto-increments based on the highest existing sequence number
     *
     * @param l2psUid - L2PS network identifier
     * @returns Promise resolving to the next sequence number
     */
    private static async getNextSequenceNumber(l2psUid: string, manager?: any): Promise<number> {
        try {
            await this.ensureInitialized()

            // Use provided manager or default repo
            const queryBuilder = manager
                ? manager.createQueryBuilder(L2PSMempoolTx, "tx")
                : this.repo!.createQueryBuilder("tx")

            const result = await queryBuilder
                .select("MAX(CAST(tx.sequence_number AS BIGINT))", "max_seq")
                .where("tx.l2ps_uid = :l2psUid", { l2psUid })
                .getRawOne()

            // result.max_seq may be a string from BIGINT cast, so we use Number() or BigInt()
            // We return Number since we expect sequence to stay within JS precision (2^53 - 1)
            const maxSeq = result?.max_seq !== null && result?.max_seq !== undefined ? Number(result.max_seq) : -1
            return maxSeq + 1
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error)
            log.error(`[L2PS Mempool] Error getting next sequence number: ${errorMsg}`)

            // If in a transaction, we want to rethrow to trigger a retry instead of falling back to timestamp
            if (manager) throw error

            // Fallback to timestamp-based sequence only for non-atomic reads
            return Date.now()
        }
    }

    /**
     * Get all L2PS transactions for a specific UID, optionally filtered by status
     * 
     * @param l2psUid - L2PS network identifier
     * @param status - Optional status filter ("pending", "processed", "executed", "failed"), or a list of statuses
     * @returns Promise resolving to array of L2PS mempool transactions
     * 
     * @example
     * ```typescript
     * // Get all executed transactions for network_1
     * const txs = await L2PSMempool.getByUID("network_1", "executed")
     * ```
     */
    public static async getByUID(l2psUid: string, status?: string | string[]): Promise<L2PSMempoolTx[]> {
        try {
            await this.ensureInitialized()

            const options: FindManyOptions<L2PSMempoolTx> = {
                where: { l2ps_uid: l2psUid },
                order: {
                    timestamp: "ASC",
                    hash: "ASC",
                },
            }

            if (Array.isArray(status)) {
                options.where = { ...options.where, status: In(status) }
            } else if (status) {
                options.where = { ...options.where, status }
            }

            return await this.repo.find(options)
        } catch (error) {
            log.error(`[L2PS Mempool] Error getting transactions for UID ${l2psUid}:`, error)
            return []
        }
    }

    /**
     * Get the latest transaction for a specific L2PS UID
     * Useful for determining sync checkpoints
     * 
     * @param l2psUid - L2PS network identifier
     * @returns Promise resolving to the latest transaction or null
     */
    public static async getLastTransaction(l2psUid: string): Promise<L2PSMempoolTx | null> {
        try {
            await this.ensureInitialized()

            return await this.repo.findOne({
                where: { l2ps_uid: l2psUid },
                order: { timestamp: "DESC" },
            })
        } catch (error) {
            log.error(`[L2PS Mempool] Error getting latest transaction for UID ${l2psUid}:`, error)
            return null
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
        return (await this.getDigestWithCount(l2psUid, blockNumber)).hash
    }

    /**
     * The consolidated hash together with the number of rows it covers, both
     * from one snapshot so they cannot disagree.
     *
     * @throws When the database cannot be read. A failure is never answered
     *         with a stand-in hash: a caller that relays the hash as a
     *         commitment would be publishing something that commits to nothing.
     */
    public static async getDigestWithCount(
        l2psUid: string,
        blockNumber?: number,
    ): Promise<{ hash: string; count: number }> {
        try {
            await this.ensureInitialized()

            const blockSuffix = blockNumber !== undefined ? `_BLOCK_${blockNumber}` : "_ALL"

            // The digest covers the count before the hashes, so the count and the
            // pages must come from one snapshot, or rows arriving between the two
            // reads would make them disagree.
            const result = await this.repo.manager.transaction("REPEATABLE READ", async manager => {
                const table = manager.getRepository(L2PSMempoolTx).metadata.tablePath
                // Only successfully executed transactions awaiting batching
                const params: unknown[] = [l2psUid, L2PS_STATUS.EXECUTED]
                let where = "l2ps_uid = $1 AND status = $2"
                if (blockNumber !== undefined) {
                    params.push(blockNumber)
                    where += " AND block_number = $3"
                }

                const [{ count: total }] = await manager.query(
                    `SELECT COUNT(*)::text AS count FROM ${table} WHERE ${where}`,
                    params,
                )
                const count = Number.parseInt(total, 10)
                if (count === 0) return null

                // Hashed a page at a time off one sorted cursor: the backlog is
                // read on every cycle and can be large, and only the running
                // digest has to stay in memory. Byte order is what .sort() gave,
                // whatever collation the database uses, because every stored key
                // is 64 hex characters: addTransaction refuses any other form.
                // Rows from before that rule are not covered by it.
                const digest = forge.sha256.create()
                digest.update(`L2PS_${l2psUid}${blockSuffix}:${count}:`)
                await manager.query(
                    `DECLARE l2ps_hash_cursor NO SCROLL CURSOR FOR SELECT hash FROM ${table} WHERE ${where} ORDER BY hash COLLATE "C"`,
                    params,
                )
                let first = true
                for (;;) {
                    const hashes: { hash: string }[] = await manager.query(
                        `FETCH ${HASH_PAGE_SIZE} FROM l2ps_hash_cursor`,
                    )
                    if (hashes.length === 0) break

                    digest.update((first ? "" : ",") + hashes.map(row => row.hash).join(","))
                    first = false
                    if (hashes.length < HASH_PAGE_SIZE) break
                }
                await manager.query("CLOSE l2ps_hash_cursor")
                return { count, digest: digest.digest().toHex() }
            })

            if (result === null) {
                // Deterministic empty hash
                const suffix = blockNumber === undefined ? "_ALL" : `_BLOCK_${blockNumber}`
                return { hash: Hashing.sha256(`L2PS_EMPTY_${l2psUid}${suffix}`), count: 0 }
            }

            log.debug(`[L2PS Mempool] Generated hash for ${l2psUid}${blockSuffix}: ${result.digest} (${result.count} txs)`)
            return { hash: result.digest, count: result.count }

        } catch (error) {
            log.error(`[L2PS Mempool] Error generating hash for UID ${l2psUid}, block ${blockNumber}:`, error)
            throw error
        }
    }

    /**
     * Subnets that have at least one executed row waiting for a batch.
     * One row per subnet comes back, so the answer is as small as the number of
     * subnets however deep a backlog is.
     */
    public static async getExecutedSubnets(): Promise<string[]> {
        await this.ensureInitialized()

        const rows = await this.repo
            .createQueryBuilder("tx")
            .select("tx.l2ps_uid", "l2ps_uid")
            .distinct(true)
            .where("tx.status = :status", { status: L2PS_STATUS.EXECUTED })
            .orderBy("tx.l2ps_uid", "ASC")
            .getRawMany()
        return rows.map(row => row.l2ps_uid)
    }

    /**
     * Queue rows for a known set of original hashes, in the given statuses.
     * For a caller that holds a page of hashes and wants the matching rows,
     * which reading the subnet's whole queue and filtering would not bound.
     *
     * @param l2psUid - L2PS network identifier
     * @param originalHashes - Original transaction hashes to look up
     * @param statuses - Statuses a matching row may be in
     */
    public static async getByOriginalHashes(
        l2psUid: string,
        originalHashes: string[],
        statuses: L2PSStatus[],
    ): Promise<L2PSMempoolTx[]> {
        if (originalHashes.length === 0) return []
        try {
            await this.ensureInitialized()

            return await this.repo.find({
                where: {
                    l2ps_uid: l2psUid,
                    original_hash: In(originalHashes),
                    status: In(statuses),
                },
            })
        } catch (error) {
            log.error(`[L2PS Mempool] Error getting transactions by original hash for UID ${l2psUid}:`, error)
            return []
        }
    }

    /**
     * One page of a subnet's queue, oldest first, with the identifying columns
     * only. Used to list queue entries to a peer, which never needs a payload,
     * and bounded so one request cannot read the whole table.
     *
     * Rows are ordered by (timestamp, hash) and the cursor is that pair, so rows
     * that share a millisecond are neither skipped nor repeated across pages.
     * Without a hash the cursor is the timestamp alone and only newer rows match.
     *
     * @param l2psUid - L2PS network identifier
     * @param after - Cursor: rows after this timestamp, or after this (timestamp, hash)
     * @param limit - Maximum rows returned
     */
    public static async getPageByUID(
        l2psUid: string,
        after: { timestamp: number; hash?: string },
        limit: number,
    ): Promise<Pick<L2PSMempoolTx, "hash" | "l2ps_uid" | "original_hash" | "status" | "timestamp">[]> {
        try {
            await this.ensureInitialized()

            const timestamp = String(Math.max(0, Math.trunc(after.timestamp)))
            const qb = this.repo
                .createQueryBuilder("tx")
                .select(["tx.hash", "tx.l2ps_uid", "tx.original_hash", "tx.status", "tx.timestamp"])
                .where("tx.l2ps_uid = :l2psUid", { l2psUid })
            if (typeof after.hash === "string") {
                qb.andWhere(
                    "(CAST(tx.timestamp AS BIGINT) > CAST(:after AS BIGINT) OR (CAST(tx.timestamp AS BIGINT) = CAST(:after AS BIGINT) AND tx.hash > :afterHash))",
                    { after: timestamp, afterHash: after.hash },
                )
            } else {
                qb.andWhere("CAST(tx.timestamp AS BIGINT) > CAST(:after AS BIGINT)", { after: timestamp })
            }
            return await qb
                .orderBy("tx.timestamp", "ASC")
                .addOrderBy("tx.hash", "ASC")
                .limit(limit)
                .getMany()
        } catch (error) {
            log.error(`[L2PS Mempool] Error paging transactions for UID ${l2psUid}:`, error)
            return []
        }
    }

    /**
     * Size and age span of the rows a subnet holds in one status, computed by
     * the database. Callers that only report a backlog use this instead of
     * loading the rows to count them.
     *
     * @param l2psUid - L2PS network identifier
     * @param status - Status to summarise
     * @returns Row count and the oldest and newest row timestamps, as the
     *          database's bigint strings (null when there are no rows)
     * @throws When the database cannot be queried
     */
    public static async getSummaryByUIDAndStatus(
        l2psUid: string,
        status: L2PSStatus,
    ): Promise<{ count: number; oldestTimestamp: string | null; newestTimestamp: string | null }> {
        // A failure is the caller's to handle: reporting zero would read as an
        // empty queue to a caller deciding whether to accept more work.
        await this.ensureInitialized()

        const row = await this.repo
            .createQueryBuilder("tx")
            .select("COUNT(*)", "count")
            .addSelect("MIN(CAST(tx.timestamp AS BIGINT))", "oldest")
            .addSelect("MAX(CAST(tx.timestamp AS BIGINT))", "newest")
            .where("tx.l2ps_uid = :l2psUid", { l2psUid })
            .andWhere("tx.status = :status", { status })
            .getRawOne()

        return {
            count: Number.parseInt(row?.count ?? "0", 10),
            oldestTimestamp: row?.oldest ?? null,
            newestTimestamp: row?.newest ?? null,
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
     * @param status - New status ("pending", "processed", "batched", "confirmed")
     * @returns Promise resolving to true if updated, false otherwise
     */
    public static async updateStatus(hash: string, status: L2PSStatus): Promise<boolean> {
        try {
            await this.ensureInitialized()

            const result = await this.repo.update(
                { hash },
                { status, timestamp: Date.now().toString() },
            )

            const updated = result.affected > 0
            if (updated) {
                log.info(`[L2PS Mempool] Updated status of ${hash} to ${status}`)
            }
            return updated

        } catch (error) {
            log.error(`[L2PS Mempool] Error updating status for ${hash}:`, error)
            return false
        }
    }

    /**
     * Update GCR edits and affected accounts count for a transaction
     * Called after transaction execution to store edits for batch aggregation
     *
     * @param hash - Transaction hash to update
     * @param gcrEdits - GCR edits generated during execution
     * @param affectedAccountsCount - Number of accounts affected (privacy-preserving)
     * @returns Promise resolving to true if updated, false otherwise
     */
    public static async updateGCREdits(
        hash: string,
        gcrEdits: GCREdit[],
        affectedAccountsCount: number,
    ): Promise<boolean> {
        try {
            await this.ensureInitialized()

            const result = await this.repo.update(
                { hash },
                {
                    gcr_edits: gcrEdits,
                    affected_accounts_count: affectedAccountsCount,
                    timestamp: Date.now().toString(),
                },
            )

            const updated = (result.affected ?? 0) > 0
            if (updated) {
                log.debug(`[L2PS Mempool] Updated GCR edits for ${hash} (${gcrEdits.length} edits, ${affectedAccountsCount} accounts)`)
            }
            return updated

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error)
            log.error(`[L2PS Mempool] Error updating GCR edits for ${hash}: ${errorMsg}`)
            return false
        }
    }

    /**
     * Batch update status for multiple transactions
     * Efficient for bulk operations like marking transactions as batched
     *
     * @param hashes - Array of transaction hashes to update
     * @param status - New status to set
     * @returns Promise resolving to number of updated records
     *
     * @example
     * ```typescript
     * const updatedCount = await L2PSMempool.updateStatusBatch(
     *     ["0xabc...", "0xdef..."],
     *     L2PS_STATUS.BATCHED
     * )
     * ```
     */
    public static async updateStatusBatch(hashes: string[], status: L2PSStatus): Promise<number> {
        try {
            if (hashes.length === 0) {
                return 0
            }

            await this.ensureInitialized()

            const result = await this.repo.update(
                { hash: In(hashes) },
                { status, timestamp: Date.now().toString() },
            )

            const updated = result.affected || 0
            if (updated > 0) {
                log.info(`[L2PS Mempool] Batch updated ${updated} transactions to status ${status}`)
            }
            return updated

        } catch (error) {
            log.error("[L2PS Mempool] Error batch updating status:", error)
            return 0
        }
    }

    /**
     * Get all transactions with a specific status
     * 
     * @param status - Status to filter by
     * @param limit - Optional limit on number of results
     * @returns Promise resolving to array of matching transactions
     * 
     * @example
     * ```typescript
     * // Get all processed transactions ready for batching
     * const readyToBatch = await L2PSMempool.getByStatus(L2PS_STATUS.EXECUTED, 100)
     * ```
     */
    public static async getByStatus(status: L2PSStatus, limit?: number): Promise<L2PSMempoolTx[]> {
        try {
            await this.ensureInitialized()

            const options: FindManyOptions<L2PSMempoolTx> = {
                where: { status },
                order: {
                    timestamp: "ASC",
                    hash: "ASC",
                },
            }

            if (limit) {
                options.take = limit
            }

            return await this.repo.find(options)
        } catch (error) {
            log.error(`[L2PS Mempool] Error getting transactions by status ${status}:`, error)
            return []
        }
    }

    /**
     * Get all transactions with a specific status for a given L2PS UID
     * 
     * @param l2psUid - L2PS network identifier
     * @param status - Status to filter by
     * @param limit - Optional limit on number of results
     * @returns Promise resolving to array of matching transactions
     */
    public static async getByUIDAndStatus(
        l2psUid: string,
        status: L2PSStatus,
        limit?: number,
    ): Promise<L2PSMempoolTx[]> {
        try {
            await this.ensureInitialized()

            const options: FindManyOptions<L2PSMempoolTx> = {
                where: { l2ps_uid: l2psUid, status },
                order: {
                    timestamp: "ASC",
                    hash: "ASC",
                },
            }

            if (limit) {
                options.take = limit
            }

            return await this.repo.find(options)
        } catch (error) {
            log.error(`[L2PS Mempool] Error getting transactions for UID ${l2psUid} with status ${status}:`, error)
            return []
        }
    }

    /**
     * Delete transactions by their hashes (for cleanup after confirmation)
     * 
     * @param hashes - Array of transaction hashes to delete
     * @returns Promise resolving to number of deleted records
     */
    public static async deleteByHashes(hashes: string[]): Promise<number> {
        try {
            if (hashes.length === 0) {
                return 0
            }

            await this.ensureInitialized()

            const result = await this.repo.delete({ hash: In(hashes) })
            const deleted = result.affected || 0

            if (deleted > 0) {
                log.info(`[L2PS Mempool] Deleted ${deleted} transactions`)
            }
            return deleted

        } catch (error) {
            log.error("[L2PS Mempool] Error deleting transactions:", error)
            return 0
        }
    }

    /**
     * Delete old batched/confirmed transactions for cleanup
     * 
     * @param status - Status of transactions to clean up (typically 'batched' or 'confirmed')
     * @param olderThanMs - Remove transactions older than this many milliseconds
     * @returns Promise resolving to number of deleted records
     */
    public static async cleanupByStatus(status: L2PSStatus, olderThanMs: number): Promise<number> {
        try {
            await this.ensureInitialized()

            const cutoffTimestamp = (Date.now() - olderThanMs).toString()

            const result = await this.repo
                .createQueryBuilder()
                .delete()
                .from(L2PSMempoolTx)
                .where("CAST(timestamp AS BIGINT) < CAST(:cutoff AS BIGINT)", { cutoff: cutoffTimestamp })
                .andWhere("status = :status", { status })
                .execute()

            const deletedCount = result.affected || 0
            if (deletedCount > 0) {
                log.info(`[L2PS Mempool] Cleaned up ${deletedCount} old ${status} transactions`)
            }
            return deletedCount

        } catch (error) {
            log.error(`[L2PS Mempool] Error during cleanup by status ${status}:`, error)
            return 0
        }
    }

    /**
     * Delete batched rows that carry no GCR edits once they are old enough, and
     * whose ciphertext the history table already holds.
     *
     * A batched row leaves the queue when the proof built from its GCR edits is
     * applied at consensus. A transaction with no edits, such as a message,
     * never gets a proof, so nothing would otherwise remove it and the queue
     * would gain a row per message for good.
     *
     * Rows written before the history table kept the ciphertext have no
     * payload there, and the history endpoint recovers theirs from this row. A
     * row without a stored payload is therefore kept, and counted in the log.
     *
     * @param olderThanMs - Remove rows whose timestamp is older than this many milliseconds
     * @returns Promise resolving to number of deleted records
     */
    public static async cleanupBatchedWithoutEdits(olderThanMs: number): Promise<number> {
        try {
            await this.ensureInitialized()

            const cutoffTimestamp = (Date.now() - olderThanMs).toString()
            const historyHasPayload =
                "EXISTS (SELECT 1 FROM l2ps_transactions h WHERE h.hash = l2ps_mempool.original_hash AND h.encrypted_payload IS NOT NULL)"

            const result = await this.repo
                .createQueryBuilder()
                .delete()
                .from(L2PSMempoolTx)
                .where("status = :status", { status: L2PS_STATUS.BATCHED })
                .andWhere("CAST(timestamp AS BIGINT) < CAST(:cutoff AS BIGINT)", { cutoff: cutoffTimestamp })
                .andWhere("(gcr_edits IS NULL OR gcr_edits = '[]'::jsonb)")
                .andWhere(historyHasPayload)
                .execute()

            const deletedCount = result.affected || 0
            if (deletedCount > 0) {
                log.info(`[L2PS Mempool] Cleaned up ${deletedCount} old batched transactions without edits`)
            }

            const kept = await this.repo
                .createQueryBuilder("tx")
                .where("tx.status = :status", { status: L2PS_STATUS.BATCHED })
                .andWhere("CAST(tx.timestamp AS BIGINT) < CAST(:cutoff AS BIGINT)", { cutoff: cutoffTimestamp })
                .andWhere("(tx.gcr_edits IS NULL OR tx.gcr_edits = '[]'::jsonb)")
                .andWhere(`NOT ${historyHasPayload.replace("l2ps_mempool.original_hash", "tx.original_hash")}`)
                .getCount()
            if (kept > 0) {
                log.info(`[L2PS Mempool] ${kept} legacy rows kept: their ciphertext is not in the history table`)
            }
            return deletedCount

        } catch (error) {
            log.error("[L2PS Mempool] Error during cleanup of batched transactions without edits:", error)
            return 0
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
            await this.ensureInitialized()

            return await this.repo.exists({ where: { original_hash: originalHash } })
        } catch (error) {
            log.error(`[L2PS Mempool] Error checking original hash ${originalHash}:`, error)
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
            await this.ensureInitialized()

            return await this.repo.exists({ where: { hash } })
        } catch (error) {
            log.error(`[L2PS Mempool] Error checking hash ${hash}:`, error)
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
            await this.ensureInitialized()

            return await this.repo.findOne({ where: { hash } })
        } catch (error) {
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
            await this.ensureInitialized()

            const cutoffTimestamp = (Date.now() - olderThanMs).toString()

            const result = await this.repo
                .createQueryBuilder()
                .delete()
                .from(L2PSMempoolTx)
                .where("CAST(timestamp AS BIGINT) < CAST(:cutoff AS BIGINT)", { cutoff: cutoffTimestamp })
                .andWhere("status = :status", { status: L2PS_STATUS.CONFIRMED })
                .execute()

            const deletedCount = result.affected || 0
            if (deletedCount > 0) {
                log.info(`[L2PS Mempool] Cleaned up ${deletedCount} old confirmed transactions`)
            }
            return deletedCount

        } catch (error) {
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
            await this.ensureInitialized()

            const totalTransactions = await this.repo.count()

            // Get transactions by UID
            const byUID = await this.repo
                .createQueryBuilder("tx")
                .select("tx.l2ps_uid", "l2ps_uid")
                .addSelect("COUNT(*)", "count")
                .groupBy("tx.l2ps_uid")
                .getRawMany()

            const transactionsByUID = byUID.reduce((acc, row) => {
                acc[row.l2ps_uid] = Number.parseInt(row.count, 10)
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
                acc[row.status] = Number.parseInt(row.count, 10)
                return acc
            }, {})

            return {
                totalTransactions,
                transactionsByUID,
                transactionsByStatus,
            }

        } catch (error) {
            log.error("[L2PS Mempool] Error getting stats:", error)
            return {
                totalTransactions: 0,
                transactionsByUID: {},
                transactionsByStatus: {},
            }
        }
    }
}
