import {
    EntityManager,
    FindManyOptions,
    ILike,
    In,
    LessThanOrEqual,
    QueryFailedError,
    Repository,
} from "typeorm"
import { Mutex } from "async-mutex"
import Datasource from "@/model/datasource"

import Chain from "./chain"
import log from "src/utilities/logger"
import { isForkActive } from "@/forks"
import { MempoolTx } from "@/model/entities/Mempool"
import { Transaction } from "@kynesyslabs/demosdk/types"
import { getSharedState } from "@/utilities/sharedState"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import TxValidatorPool from "./validation/txValidatorPool"
import { chunkedInsert } from "./chainDb"
import { verifyGcrEditsMatch } from "./validation/verifyGcrEdits"
import SecretaryManager from "../consensus/v2/types/secretaryManager"

/**
 * System relay transaction types: node-generated txs that carry no
 * balance edits and no `nonce` GCR edit, so they never advance the
 * sender's account.nonce. Their `content.nonce` is monotonic-for-
 * uniqueness (see L2PSBatchAggregator.getNextBatchNonce), NOT a
 * sequential per-account counter, so the value-transfer nonce TOCTOU
 * check in `addTransaction` must not apply to them. Admission is still
 * gated on the tx originating from THIS node's own identity (see
 * `addTransaction`) so an arbitrary signer cannot label a tx with one
 * of these types to bypass the per-account nonce throttle.
 */
const SYSTEM_RELAY_TX_TYPES = new Set<string>(["l2psBatch"])

export default class Mempool {
    public static lock = new Mutex()

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

    /**
     * Add a transaction to the mempool with exclusive lock
     *
     * @param transaction - The transaction to add to the mempool
     * @param blockRef - The block number to add the transaction to
     * @returns The confirmation block and error if any
     */
    public static async addTransactionWithLock(
        transaction: Transaction & { reference_block: number },
        blockRef?: number,
    ) {
        return await this.lock.runExclusive(
            async () => await this.addTransaction(transaction, blockRef),
        )
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
        // fork inactive, when the tx doesn't carry a nonce, or when the
        // tx is a system relay type (see below) — those paths preserve
        // the legacy behaviour bit-identically.
        const senderFromRaw = transaction.content?.from
        const senderFrom =
            typeof senderFromRaw === "string"
                ? senderFromRaw.toLowerCase()
                : null
        const txNonce = transaction.content?.nonce
        const blockHeight = getSharedState.lastBlockNumber ?? 0

        // System relay transactions (SYSTEM_RELAY_TX_TYPES, e.g.
        // `l2psBatch`) carry a node-generated monotonic-for-uniqueness
        // nonce, not a sequential per-account counter, and never advance
        // the sender's account.nonce (no `nonce` GCR edit). The
        // sequential `account.nonce + 1 + pendingCount` check below is
        // built for value-transfer txs and would reject every batch (the
        // timestamp nonce never equals account.nonce+1), trapping the
        // L2PSBatchAggregator in a permanent retry loop.
        //
        // The exemption is gated on the tx originating from THIS node's
        // OWN identity. The aggregator only ever submits batch txs from
        // the node's own keypair, via a direct local addTransaction call;
        // legitimate batch txs reach other nodes inside a block, not via
        // mempool admission. Gating on own-identity means an arbitrary
        // signer (or a remote peer) cannot self-label a tx `l2psBatch`
        // to skip the per-account nonce throttle and flood the mempool —
        // their `from` won't match this node's identity and they stay on
        // the enforced path. Replay safety for the node's own batches
        // comes from the in-mempool hash dedup above, not the nonce.
        const ownIdentityHex =
            getSharedState.publicKeyHex?.toLowerCase() ?? null
        const isOwnSystemRelayTx =
            typeof transaction.content?.type === "string" &&
            SYSTEM_RELAY_TX_TYPES.has(transaction.content.type) &&
            ownIdentityHex !== null &&
            senderFrom === ownIdentityHex

        if (
            senderFrom &&
            typeof txNonce === "number" &&
            !isOwnSystemRelayTx &&
            isForkActive("nonceEnforcement", blockHeight)
        ) {
            try {
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

                        // Check transaction hash in transaction table
                        const tx = await Chain.getTransactionFromHash(
                            transaction.hash,
                        )
                        if (tx) {
                            return {
                                confirmationBlock: null,
                                error:
                                    "Transaction already executed in block number: " +
                                    tx.blockNumber,
                            }
                        }

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

                        const gcrRepo = em.getRepository(GCRMain)
                        const account = await gcrRepo.findOne({
                            where: { pubkey: senderFrom },
                        })

                        const accountNonce = account?.nonce ?? 0
                        if (txNonce <= accountNonce) {
                            log.error(
                                `[Mempool.addTransaction] Invalid nonce for ${senderFrom}: ` +
                                    `tx.content.nonce=${txNonce}, expected >=${accountNonce + 1} `,
                            )

                            return {
                                confirmationBlock: null,
                                error:
                                    "Invalid nonce for transaction: " +
                                    transaction.hash +
                                    " (expected >= " +
                                    (accountNonce + 1) +
                                    ")",
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
        // A gossiped native tx was confirmed upstream, so when
        // gasFeeSeparation is active it ALREADY carries the node-computed fee
        // edits (verified: the originator's confirmTransaction prepended them;
        // getMempool serves the stored mutated tx). verifyGcrEditsMatch with
        // expectFeeEdits reproduces those fee edits from the SHIPPED
        // transaction_fee (incl. the originator's rpc_address) so the match
        // holds cross-node (audit 184). expectFeeEdits is keyed on the fork so
        // pre-fork the regen stays fee-free.
        // Epic #21 #204: at INGRESS the gossiped tx is byte-identical to what
        // the sender signed — confirmTransaction no longer prepends fee edits
        // onto it (those are derived at apply). So the shipped set carries NO
        // fee edits here; the binding regen must NOT add them either, or every
        // legit tx false-mismatches. (Fee edits are bound at apply, where they
        // are derived: see HandleGCR.applyTransactions.)
        {
            const editVerifiedTransactions: Transaction[] = []
            for (const tx of validTransactions) {
                if (tx.content?.type !== "native") {
                    editVerifiedTransactions.push(tx)
                    continue
                }
                try {
                    const { match } = await verifyGcrEditsMatch(tx, {
                        expectFeeEdits: false,
                    })
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
