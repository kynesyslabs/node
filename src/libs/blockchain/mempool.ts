import {
    EntityManager,
    FindManyOptions,
    ILike,
    In,
    LessThanOrEqual,
    QueryFailedError,
    Repository,
} from "typeorm"
import Datasource from "@/model/datasource"

import log from "src/utilities/logger"
import { MempoolTx } from "@/model/entities/Mempool"
import { Transaction } from "@kynesyslabs/demosdk/types"
import SecretaryManager from "../consensus/v2/types/secretaryManager"
import Chain from "./chain"
import { getSharedState } from "@/utilities/sharedState"
import TxValidatorPool from "./validation/txValidatorPool"
import { verifyGcrEditsMatch } from "./validation/verifyGcrEdits"
import { CHUNK_MEMPOOL_TX, chunkedInsert } from "./chainDb"
import { isForkActive } from "@/forks"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"

export default class Mempool {
    public static repo: Repository<MempoolTx> = null
    public static async init() {
        const db = await Datasource.getInstance()
        this.repo = db.getDataSource().getRepository(MempoolTx)
    }

    /**
     * Returns the mempool. If `blockNumber` is not provided, returns all transactions.
     * When `blockNumber` is transaction past from a previous block number are included.
     *
     * @param blockNumber - The block number to filter by
     */
    public static async getMempool(blockNumber?: number) {
        const options: FindManyOptions<MempoolTx> = {
            order: {
                timestamp: "ASC",
                reference_block: "ASC",
                hash: "ASC",
            },
        }

        if (blockNumber) {
            options.where = {
                blockNumber: LessThanOrEqual(blockNumber),
            }
        }

        return (await this.repo.find(options)) as (Transaction & {
            reference_block: number
        })[]
    }

    /**
     * Returns a map of mempool hashes (for lookup only)
     */
    public static async getMempoolHashMap(blockNumber: number) {
        const hashes = await this.repo.find({
            select: ["hash"],
            where: { blockNumber: LessThanOrEqual(blockNumber) },
        })

        return hashes.reduce((acc, tx) => {
            acc[tx.hash] = true
            return acc
        }, {})
    }

    public static async getTransactionsByHashes(hashes: string[]) {
        return await this.repo.find({ where: { hash: In(hashes) } })
    }

    public static async checkTransactionByHash(hash: string) {
        return await this.repo.exists({ where: { hash: hash } })
    }

    /**
     * Cheap mempool size lookup — used by /health.
     */
    public static async count(): Promise<number> {
        return await this.repo.count()
    }

    /**
     * Audit-sweep batch C PR 2 — count pending txs from a given sender.
     *
     * Used by `assignNonce` to compute the next expected nonce when a
     * sender has prior txs already queued in mempool but not yet
     * included in a block. The pattern is:
     *
     *   expected_nonce = account.nonce + 1 + countPendingByAddress(sender)
     *
     * Counts every tx whose `content.from` matches the supplied
     * lowercase hex address AND whose `reference_block` is still
     * inside the allowed window
     * (`lastBlock - referenceBlockRoom ..= lastBlock`) — the same
     * cut-off that `cleanMempool` uses to mark a tx stale and that
     * `isReferenceBlockAllowed` enforces on inbound RPC. Without the
     * window filter, expired-but-not-yet-swept rows would inflate
     * the count and block every subsequent legitimate submission
     * until the next mempool sweep ran (PR #885 Greptile P1).
     *
     * Cross-node correctness is not the goal here — the mempool is
     * the single-writer source of truth for queue depth on this node.
     * Another node may have a different pending set. The
     * consensus-time `expectedPrior` check shipped in PR 3 is the
     * cross-node safety net.
     *
     * Case sensitivity: the SDK and the rest of the codebase emit
     * addresses as lowercase hex (`0x` + 64 hex chars). Stored
     * `content.from` strings can in principle carry mixed case, so
     * the comparison is lowercased on both sides via the SQL
     * `LOWER(...)` function. Callers should still lowercase their
     * input as defence in depth.
     *
     * @param address Lowercase hex pubkey of the sender.
     * @returns Number of in-window mempool rows from this sender.
     */
    public static async countPendingByAddress(
        address: string,
    ): Promise<number> {
        const lastBlock = await Chain.getLastBlockNumber()
        const cutoff = lastBlock - getSharedState.referenceBlockRoom
        return await this.repo
            .createQueryBuilder("tx")
            .where("LOWER(tx.content->>'from') = LOWER(:address)", {
                address,
            })
            .andWhere("tx.reference_block >= :cutoff", { cutoff })
            .getCount()
    }

    /**
     * Case-insensitive mempool lookup by transaction hash. Returns the
     * MempoolTx row or null if the hash is not in the mempool.
     */
    public static async findByHash(hash: string): Promise<MempoolTx | null> {
        return await this.repo.findOne({ where: { hash: ILike(hash) } })
    }

    public static async addTransaction(
        transaction: Transaction & { reference_block: number },
        blockRef?: number,
    ) {
        const txExists = await Chain.checkTxExists(transaction.hash)
        if (txExists) {
            return {
                confirmationBlock: null,
                error: "Transaction already executed",
            }
        }

        const mempoolTx = await this.checkTransactionByHash(transaction.hash)
        if (mempoolTx) {
            return {
                confirmationBlock: null,
                error: "Transaction already in mempool",
            }
        }

        if (blockRef === undefined) {
            blockRef = getSharedState.lastBlockNumber + 1

            if (getSharedState.inConsensusLoop) {
                blockRef = SecretaryManager.lastBlockRef + 1
            }
        }

        // Audit-sweep batch C PR 4 — close the validate→addTransaction
        // TOCTOU window for `nonceEnforcement`.
        //
        // `assignNonce` ran during the earlier `confirmTransaction`
        // call, but that's a separate RPC round-trip from this
        // execute-side insert. Between the two, two concurrent
        // ingress paths for the same sender can both pass validation
        // (each sees stale `account.nonce + pendingCount`) and reach
        // here with duplicate nonces. The consensus-side
        // `expectedPrior` check in `GCRNonceRoutines` (PR 3) catches
        // them at block-apply time, but only after they both occupy
        // mempool slots. Closing the gap at the insert point keeps
        // the mempool clean and rejects the duplicate immediately.
        //
        // Design: wrap re-check + insert in a Postgres txn with a
        // per-sender `pg_advisory_xact_lock`. Lock released at
        // commit/rollback. Re-query account nonce + mempool count
        // INSIDE the locked section so the values reflect any
        // concurrent winner that beat us into the lock. If the
        // re-check fails, return error without inserting.
        //
        // Skip when not native, when no sender (genesis path), when
        // fork inactive, or when the tx doesn't carry a nonce —
        // those paths preserve the legacy behaviour bit-identically.
        const senderFromRaw = transaction.content?.from
        const senderFrom =
            typeof senderFromRaw === "string"
                ? senderFromRaw.toLowerCase()
                : null
        const txNonce = transaction.content?.nonce
        const blockHeight = getSharedState.lastBlockNumber ?? 0

        if (
            senderFrom &&
            typeof txNonce === "number" &&
            isForkActive("nonceEnforcement", blockHeight)
        ) {
            try {
                // PR #887 Greptile P1: explicit `READ COMMITTED`. The
                // default Postgres txn isolation can be flipped by
                // server / connection-pool config, and under
                // `REPEATABLE READ` or `SERIALIZABLE` the txn
                // snapshot is taken at `BEGIN` — BEFORE the advisory
                // lock fires — so the in-lock re-query of
                // `pendingCount` would see stale data and the entire
                // TOCTOU guarantee silently collapses. Pinning the
                // level here makes the lock + recheck semantics
                // independent of operator configuration.
                return await this.repo.manager.transaction(
                    "READ COMMITTED",
                    async em => {
                        // Postgres advisory locks operate on signed
                        // bigint keys. `hashtext()` returns a 32-bit
                        // signed int — ample collision space for
                        // distinct senders, no false-positive
                        // interference with other lock keyspaces in
                        // the project (none exist yet).
                        await em.query(
                            "SELECT pg_advisory_xact_lock(hashtext($1))",
                            [`nonce:${senderFrom}`],
                        )

                        // PR #887 Greptile P2: re-check the hash
                        // INSIDE the lock so a second concurrent
                        // submission of the identical tx (same
                        // hash) gets a clear "already in mempool"
                        // error instead of falling through to the
                        // nonce-mismatch message. The outer
                        // `checkTransactionByHash` runs before the
                        // lock and lets both racers past, so the
                        // in-lock check is the only place where
                        // duplicate-hash concurrency is
                        // distinguishable from nonce reuse.
                        const mempoolRepo = em.getRepository(MempoolTx)
                        const hashExists = await mempoolRepo.exists({
                            where: { hash: transaction.hash },
                        })
                        if (hashExists) {
                            return {
                                confirmationBlock: null,
                                error: "Transaction already in mempool",
                            }
                        }

                        // Re-check inside the lock. The account row
                        // may have advanced (a concurrent submission
                        // committed); the mempool count likely
                        // changed.
                        const gcrRepo = em.getRepository(GCRMain)
                        const account = await gcrRepo.findOne({
                            where: { pubkey: senderFrom },
                        })
                        if (!account) {
                            return {
                                confirmationBlock: null,
                                error: "Nonce TOCTOU recheck: sender account missing",
                            }
                        }

                        // PR #887 Greptile P1 (iter 2): live re-query
                        // of the block tip inside the lock.
                        // `blockHeight` outside the lock is the
                        // `getSharedState.lastBlockNumber` snapshot
                        // captured before any await; a block produced
                        // between `confirmTransaction` and
                        // `addTransaction` would diverge from the
                        // cutoff `assignNonce` used (which goes
                        // through `Chain.getLastBlockNumber()` —
                        // `countPendingByAddress`). Mirror that path
                        // so both windows align on the same
                        // block tip and a still-valid tx is never
                        // rejected for a stale-cutoff mismatch.
                        const liveBlockHeight =
                            await Chain.getLastBlockNumber()
                        const cutoff =
                            liveBlockHeight -
                            getSharedState.referenceBlockRoom
                        const pendingCount = await mempoolRepo
                            .createQueryBuilder("tx")
                            .where(
                                "LOWER(tx.content->>'from') = LOWER(:address)",
                                { address: senderFrom },
                            )
                            .andWhere("tx.reference_block >= :cutoff", {
                                cutoff,
                            })
                            .getCount()

                        const expected = account.nonce + 1 + pendingCount
                        if (txNonce !== expected) {
                            log.error(
                                `[Mempool.addTransaction] Nonce TOCTOU recheck mismatch for ${senderFrom}: ` +
                                    `tx.content.nonce=${txNonce}, expected=${expected} ` +
                                    `(account.nonce=${account.nonce}, pendingMempoolCount=${pendingCount})`,
                            )
                            return {
                                confirmationBlock: null,
                                error:
                                    "Nonce TOCTOU recheck failed: " +
                                    `tx.content.nonce=${txNonce}, expected=${expected}`,
                            }
                        }

                        const saved = await mempoolRepo.save({
                            ...transaction,
                            timestamp: BigInt(transaction.content.timestamp),
                            nonce: transaction.content.nonce,
                            blockNumber: blockRef,
                        })

                        return {
                            confirmationBlock: saved.blockNumber,
                            error: "",
                        }
                    },
                )
            } catch (error) {
                let message = "Error: Failed to add transaction to mempool"
                if (error instanceof QueryFailedError) {
                    log.error(`Error saving tx: ${transaction.hash}`)
                    log.error(error.message)
                    message = "Error: Transaction already in mempool"
                }
                return {
                    confirmationBlock: null,
                    error: message,
                }
            }
        }

        try {
            const saved = await this.repo.save({
                ...transaction,
                timestamp: BigInt(transaction.content.timestamp),
                nonce: transaction.content.nonce,
                blockNumber: blockRef,
            })

            return {
                confirmationBlock: saved.blockNumber,
                error: "",
            }
        } catch (error) {
            let message = "Error: Failed to add transaction to mempool"

            if (error instanceof QueryFailedError) {
                log.error(`Error saving tx: ${transaction.hash}`)
                log.error(error.message)
                message = "Error: Transaction already in mempool"
            }

            return {
                confirmationBlock: null,
                error: message,
            }
        }
    }

    public static async removeTransactionsByHashes(
        hashes: string[],
        transactionalEntityManager?: EntityManager,
    ) {
        // Use transactional EM for atomicity if provided by caller
        const repo = transactionalEntityManager
            ? transactionalEntityManager.getRepository(this.repo.target)
            : this.repo
        return await repo.delete({ hash: In(hashes) })
    }

    public static async receive(incoming: Transaction[], returnDiff = true) {
        if (incoming.length === 0) {
            return {
                success: true,
                mempool: [],
            }
        }

        // INFO: Transactions not to send back back
        const noSendBackTxs = new Map<string, string>()

        const blockNumber = SecretaryManager.lastBlockRef
        const existingHashes = await this.getMempoolHashMap(blockNumber)

        const unseenTransactions = incoming.filter(
            tx => !existingHashes[tx.hash],
        )

        log.only(
            "[Mempool.receive] Unseen transcations: " +
                JSON.stringify(
                    unseenTransactions.map(tx => tx.hash),
                    null,
                    2,
                ),
        )
        log.only(
            `[Mempool.receive] Unseen transactions: ${unseenTransactions.length}`,
        )

        if (unseenTransactions.length === 0) {
            const incomingHashes = new Set(incoming.map(tx => tx.hash))
            const finalPool = await this.getMempool(blockNumber)
            const final = finalPool.filter(
                tx =>
                    tx.blockNumber <= blockNumber &&
                    !incomingHashes.has(tx.hash),
            )

            return {
                success: true,
                mempool: final,
            }
        }

        const now = Date.now()
        // Coherence must canonicalize tx amounts the same way the
        // signer/consensus do (audit H1). Compute the osDenomination fork
        // state at the node-local chain tip here and thread it into the
        // validator (the worker has no forkConfig/height). Height from local
        // state — never tx.blockNumber.
        const coherenceIsPostFork = isForkActive(
            "osDenomination",
            getSharedState.lastBlockNumber ?? 0,
        )
        const results = await TxValidatorPool.getInstance().validate(
            unseenTransactions,
            coherenceIsPostFork,
        )
        const end = Date.now()
        log.only(
            `[Mempool.receive] TxValidatorPool.validate() took ${end - now}ms for ${unseenTransactions.length} transactions`,
        )

        const validTransactions: Transaction[] = []
        for (let i = 0; i < unseenTransactions.length; i++) {
            const r = results[i]
            if (!r.valid) {
                log.error(`[Mempool.receive] Invalid tx ${r.hash}: ${r.reason}`)
                continue
            }
            validTransactions.push(unseenTransactions[i])
        }

        // AUDIT C1 (admission-side): the worker pool checks coherence +
        // signature only — NOT that the attached gcr_edits are legitimately
        // derived from the signed body. A self-signed tx carrying a forged
        // edit (e.g. {balance, add, self, HUGE}) passes both and, before this
        // gate, entered the mempool + gossiped shard-wide. Re-derive the
        // expected edits here on the main thread and drop any tx whose shipped
        // edits don't match. Runs on the main thread (not the worker, which
        // deliberately avoids the SDK encryption index). Native txs only —
        // non-native bundles carry no gcr_edits to forge.
        //
        // FORK GUARD: when gasFeeSeparation is active, confirmTransaction
        // PREPENDS node-computed fee edits onto tx.content.gcr_edits before the
        // tx is stored/gossiped, so a peer-received native tx legitimately
        // carries edits that GCRGeneration.generate (which does NOT emit fee
        // edits) would not reproduce — verifying here would false-reject every
        // legit tx. gasFeeSeparation ships disabled; the apply-time, fork-gated
        // enforcement (audit C1-apply) is the correct place to bind edits once
        // that fork is live. So this admission guard only runs while the fork
        // is inactive, where tx.content.gcr_edits is still the raw SDK shape.
        const feeSeparationActive = isForkActive(
            "gasFeeSeparation",
            getSharedState.lastBlockNumber ?? 0,
        )
        if (!feeSeparationActive) {
            const editVerifiedTransactions: Transaction[] = []
            for (const tx of validTransactions) {
                if (tx.content?.type !== "native") {
                    editVerifiedTransactions.push(tx)
                    continue
                }
                try {
                    const { match } = await verifyGcrEditsMatch(tx)
                    if (!match) {
                        log.error(
                            `[Mempool.receive] Rejecting tx ${tx.hash}: gcr_edits do not match regenerated set (forged-edit guard)`,
                        )
                        continue
                    }
                    editVerifiedTransactions.push(tx)
                } catch (e) {
                    // Could not verify → reject (fail closed). A tx we cannot
                    // bind must not be admitted.
                    log.error(
                        `[Mempool.receive] Rejecting tx ${tx.hash}: gcr_edits verification error: ${e instanceof Error ? e.message : String(e)}`,
                    )
                }
            }
            validTransactions.length = 0
            validTransactions.push(...editVerifiedTransactions)
        }

        log.only(
            `[Mempool.receive] Valid transactions: ${validTransactions.length}`,
        )

        for (const tx of validTransactions) {
            noSendBackTxs.set(tx.hash, tx.hash)
        }

        if (validTransactions.length > 0) {
            try {
                const { inserted } = await chunkedInsert(
                    this.repo,
                    MempoolTx,
                    validTransactions as any[],
                    CHUNK_MEMPOOL_TX,
                    {
                        conflictTarget: ["hash"],
                        overwrite: ["blockNumber"],
                    },
                )
                log.only(
                    `[Mempool.receive] Inserted ${inserted}/${validTransactions.length} transactions`,
                )
            } catch (error) {
                log.error("[Mempool.receive] Error saving received mempool:")
                console.error(error)
            }
        }

        if (!returnDiff) {
            return {
                success: true,
                mempool: [],
            }
        }

        // DEBUG: Confirm all inserted transactions are in the mempool

        const finalPool = await this.getMempool(blockNumber)
        log.only("[Mempool.receive] Final pool size: " + finalPool.length)

        // INFO: Redundancy
        // INFO: Return the difference to the caller node
        const final = finalPool.filter(
            tx => tx.blockNumber === blockNumber && !noSendBackTxs.has(tx.hash),
        )
        return {
            success: true,
            mempool: final,
        }
    }

    /**
     * Returns the difference between the mempool and the given transaction hashes
     *
     * @param txHashes - Array of transaction hashes
     * @returns Array of transaction hashes that are not in the mempool
     */
    public static async getDifference(txHashes: string[]) {
        const incomingSet = new Set(txHashes)
        const mempool = await this.getMempool(SecretaryManager.lastBlockRef)
        return mempool.filter(tx => !incomingSet.has(tx.hash))
    }

    /**
     * Removes a specific transaction from the mempool by hash
     * Used by DTR relay service when transactions are successfully relayed to validators
     * @param txHash - Hash of the transaction to remove
     * @returns {Promise<void>}
     */
    static async removeTransaction(txHash: string): Promise<void> {
        try {
            const result = await this.repo.delete({ hash: txHash })

            if (result.affected > 0) {
                log.debug(
                    `[Mempool] Removed transaction ${txHash} (DTR relay success)`,
                )
            } else {
                log.debug(
                    `[Mempool] Transaction ${txHash} not found for removal`,
                )
            }
        } catch (error) {
            log.error(
                `[Mempool] Error removing transaction ${txHash}: ${error}`,
            )
            throw error
        }
    }

    /**
     * Removes old and executed transactions from the mempool.
     *
     * Old: reference_block falls outside the allowed window
     * (lastBlock - referenceBlockRoom ..= lastBlock) — same rule enforced by
     * isReferenceBlockAllowed on inbound RPC.
     *
     * Executed: already committed to the chain.
     */
    static async cleanMempool(): Promise<{
        staleRemoved: number
        executedRemoved: number
    }> {
        const all = await this.repo.find({
            select: ["hash", "reference_block"],
        })
        if (all.length === 0) {
            log.debug("[Mempool.cleanMempool] Mempool is empty")
            return { staleRemoved: 0, executedRemoved: 0 }
        }

        const lastBlock = await Chain.getLastBlockNumber()
        const cutoff = lastBlock - getSharedState.referenceBlockRoom

        const staleHashes: string[] = []
        const survivorHashes: string[] = []
        for (const tx of all) {
            if (tx.reference_block < cutoff) staleHashes.push(tx.hash)
            else survivorHashes.push(tx.hash)
        }

        const existing =
            survivorHashes.length > 0
                ? await Chain.getExistingTransactionHashes(survivorHashes)
                : new Set<string>()
        const executedHashes = survivorHashes.filter(h => existing.has(h))

        log.debug(
            `[Mempool.cleanMempool] Stale (${staleHashes.length}): ${staleHashes.join(", ")}`,
        )
        log.debug(
            `[Mempool.cleanMempool] Executed (${executedHashes.length}): ${executedHashes.join(", ")}`,
        )

        const toDelete = [...staleHashes, ...executedHashes]
        if (toDelete.length === 0) {
            log.debug("[Mempool.cleanMempool] Nothing to delete")
            return { staleRemoved: 0, executedRemoved: 0 }
        }

        if (toDelete.length === all.length) {
            await this.repo.createQueryBuilder().delete().execute()
            log.debug(
                `[Mempool.cleanMempool] Cleared entire mempool (${toDelete.length} txs)`,
            )
        } else {
            await this.repo.delete({ hash: In(toDelete) })
            log.debug(
                `[Mempool.cleanMempool] Deleted ${toDelete.length} txs by hash`,
            )
        }

        return {
            staleRemoved: staleHashes.length,
            executedRemoved: executedHashes.length,
        }
    }
}
