import { In, LessThan, EntityManager, FindManyOptions } from "typeorm"
import log from "src/utilities/logger"
import Transaction, { toTransactionsEntity } from "./transaction"
import { Transactions } from "src/model/entities/Transactions"
import { L2PSHash } from "src/model/entities/L2PSHashes"
import { chunkedInsert, getTransactionsRepo } from "./chainDb"
import type { TransactionContent } from "@kynesyslabs/demosdk/types"
import type { L2PSHashUpdatePayload, TxStatus } from "./chainTypes"
import Mempool from "./mempool"
import { getSharedState } from "@/utilities/sharedState"
import { getBlockByHash } from "./chainBlocks"
import { txMap as consensusTxMap } from "../consensus/v2/PoRBFT"
import { TRANSACTION_STATUS } from "@/utilities/constants"
import { debugAssertionsEnabled } from "src/libs/debug/nonceTrace"
import {
    INDEX_KEY_MAX_BYTES,
    NUL_NOT_STORABLE,
    fitsIndexKey,
    isTextStorable,
} from "./validation/postgresStorable"

export function getL2PSHashUpdatePayload(
    tx: Transaction,
): L2PSHashUpdatePayload | null {
    if (tx.content?.type !== "l2ps_hash_update") {
        return null
    }

    const payload = tx.content?.data?.[1]
    if (
        !payload ||
        typeof payload !== "object" ||
        !("l2ps_uid" in payload) ||
        !("consolidated_hash" in payload) ||
        !("transaction_count" in payload)
    ) {
        return null
    }

    return payload as L2PSHashUpdatePayload
}

const INT4_MIN = -(2 ** 31)
const INT4_MAX = 2 ** 31 - 1

const isInt4 = (value: unknown) =>
    (typeof value === "number" || (typeof value === "string" && /^-?\d+$/.test(value))) &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) >= INT4_MIN &&
    Number(value) <= INT4_MAX

/**
 * Why the `l2ps_hashes` row of `payload` cannot be written, or null. The row
 * is written inside the block's database transaction for every listed
 * l2ps_hash_update, failed or not, so a value Postgres refuses there would
 * fail the block's commit on every node.
 */
export function l2psHashRowRefusal(payload: L2PSHashUpdatePayload): string | null {
    for (const column of ["l2ps_uid", "consolidated_hash"] as const) {
        const value: unknown = payload[column]
        if (typeof value !== "string") return `${column} is not a string`
        if (!isTextStorable(value)) return `${column} ${NUL_NOT_STORABLE}`
    }
    // The primary key of the row: a b-tree entry.
    if (!fitsIndexKey(payload.l2ps_uid)) {
        return `l2ps_uid is longer than ${INDEX_KEY_MAX_BYTES} bytes`
    }
    if (!isInt4(payload.transaction_count)) {
        return "transaction_count is not a 32-bit integer"
    }
    return null
}

export async function persistConfirmedTransactionProjection(
    tx: Transaction,
    blockNumber: number,
    transactionalEntityManager: EntityManager,
): Promise<void> {
    const l2psHashPayload = getL2PSHashUpdatePayload(tx)
    if (!l2psHashPayload) {
        return
    }
    const refusal = l2psHashRowRefusal(l2psHashPayload)
    if (refusal !== null) {
        log.warning(
            `[ChainDB] l2ps_hash_update ${tx.hash} in block ${blockNumber} not materialized: ${refusal}`,
        )
        return
    }

    await transactionalEntityManager.save(L2PSHash, {
        l2ps_uid: l2psHashPayload.l2ps_uid,
        hash: l2psHashPayload.consolidated_hash,
        transaction_count: l2psHashPayload.transaction_count,
        block_number: blockNumber.toString(),
        timestamp: Date.now().toString(),
    })

    log.info(
        `[ChainDB] [ INFO ]: Materialized l2ps_hash_update for ${l2psHashPayload.l2ps_uid} in block ${blockNumber}`,
    )
}

export async function getTxByHash(hash: string): Promise<Transaction | null> {
    try {
        const getTxByHashStart = Date.now()
        const rawTx = await getTransactionsRepo().findOneBy({
            hash: hash,
        })

        if (!rawTx) {
            return null
        }

        const convertToTransactionStart = Date.now()
        const tx = Transaction.fromRawTransaction(rawTx)
        const convertToTransactionEnd = Date.now()
        log.only(
            `[getTxByHash] Convert to transaction took ${convertToTransactionEnd - convertToTransactionStart}ms`,
        )
        const getTxByHashEnd = Date.now()
        log.only(
            `[getTxByHash] Get tx by hash took ${getTxByHashEnd - getTxByHashStart}ms`,
        )
        return tx
    } catch (error) {
        log.error(`[ChainDB] [ ERROR ]: ${JSON.stringify(error)}`)
        throw error
    }
}

// Attrs of a synced block come from a peer; bound what is echoed to clients.
const MAX_CODE_LENGTH = 64
const MAX_MESSAGE_LENGTH = 512

/**
 * Lifecycle status of a transaction by hash.
 *
 * The chain is read before the mempool: a transaction leaving the mempool
 * for a block between the two reads is then reported unknown, which the
 * caller's height bound (read before both) still makes true, rather than
 * pending after it is in a block.
 */
export async function getTransactionStatus(hash: string): Promise<TxStatus> {
    const tx = await getTxByHash(hash)
    if (tx) {
        const blockNumber = tx.blockNumber ?? undefined
        if (tx.status === TRANSACTION_STATUS.FAILED) {
            const code = tx.attrs?.code
            const message = tx.attrs?.message
            return {
                state: "failed",
                blockNumber,
                ...(typeof code === "string" ? { code: code.slice(0, MAX_CODE_LENGTH) } : {}),
                ...(typeof message === "string" ? { message: message.slice(0, MAX_MESSAGE_LENGTH) } : {}),
            }
        }
        return { state: "included", blockNumber }
    }

    const inMempool = await Mempool.findByHash(hash)
    if (inMempool) return { state: "pending" }

    return { state: "unknown" }
}

export async function getTransactionHistory(
    address: string,
    txtype: TransactionContent["type"] | "all",
    start = 0,
    limit = 100,
) {
    const whereConditions: any[] = [{ from: address }, { to: address }]

    if (txtype !== "all") {
        whereConditions[0].type = txtype
        whereConditions[1].type = txtype
    }

    const transaction = await getTransactionsRepo().find({
        where: whereConditions,
        order: {
            timestamp: "DESC",
        },
        take: limit,
        skip: start,
    })

    return transaction.map(tx => Transaction.fromRawTransaction(tx))
}

export async function getBlockTransactions(
    blockHash: string,
): Promise<Transaction[]> {
    let txHashes: Set<string>
    const txs = []

    if (
        getSharedState.candidateBlock &&
        blockHash === getSharedState.candidateBlock.hash
    ) {
        txHashes = new Set(
            getSharedState.candidateBlock.content.ordered_transactions,
        )
        const mempoolTxs = []
        const status = new Set([
            TRANSACTION_STATUS.CONFIRMED,
            TRANSACTION_STATUS.FAILED,
        ])

        for (const hash of txHashes) {
            const tx = consensusTxMap.get(hash)

            if (tx) {
                mempoolTxs.push(tx)

                // NODE_CRITICAL_DEBUG (DO NOT REMOVE COMMENTED OUT CODE):
                if (!status.has(tx.status)) {
                    log.error(
                        "Transaction status mismatch: " +
                            hash +
                            " " +
                            tx.status,
                    )
                    if (debugAssertionsEnabled()) {
                        process.exit(1)
                    }
                }
            }
        }

        for (const tx of mempoolTxs) {
            txs.push(tx)
            txHashes.delete(tx.hash)
        }
    }

    if (txHashes === undefined) {
        // find block by hash
        const block = await getBlockByHash(blockHash)
        if (!block) {
            return []
        }

        txHashes = new Set(block.content.ordered_transactions)
    }

    if (txHashes && txHashes.size > 0) {
        // fetch transactions from the database
        const dbTxs = await getTransactionsFromHashes(Array.from(txHashes))
        txs.push(...dbTxs)
    }

    return txs
}

export async function getTransactionFromHash(
    hash: string,
): Promise<Transaction | null> {
    const rawTx = await getTransactionsRepo().findOneBy({ hash: hash })
    if (!rawTx) {
        return null
    }
    return Transaction.fromRawTransaction(rawTx)
}

export async function getTransactionsFromHashes(
    hashes: string[],
): Promise<Transaction[]> {
    const rawTransactions = await getTransactionsRepo().find({
        where: { hash: In(hashes) },
    })

    return rawTransactions.map(rawTransaction =>
        Transaction.fromRawTransaction(rawTransaction),
    )
}

export async function getTransactions(
    start: "latest" | number,
    limit: number,
): Promise<Transactions[]> {
    const maxLimit = 100
    const calculatedLimit = Math.min(limit, maxLimit)

    let options: FindManyOptions<Transactions> = {
        order: { id: "DESC" },
        take: calculatedLimit,
    }

    if (start !== "latest") {
        options = { ...options, where: { id: LessThan(start + 1) } }
    }

    return await getTransactionsRepo().find(options)
}

export async function checkTxExists(hash: string): Promise<boolean> {
    return await getTransactionsRepo().exists({ where: { hash: hash } })
}

export async function getExistingTransactionHashes(
    hashes: string[],
): Promise<Set<string>> {
    if (hashes.length === 0) return new Set()

    const rows = await getTransactionsRepo().find({
        where: { hash: In(hashes) },
        select: ["hash"],
    })

    return new Set(rows.map(r => r.hash))
}

export async function insertTransaction(
    transaction: Transaction,
): Promise<boolean> {
    log.debug("[insertTransaction] Inserting transaction: " + transaction.hash)
    const rawTransaction = Transaction.toRawTransaction(transaction)

    try {
        // REVIEW P5a: bridge wire-shape `RawTransaction` to entity-shape
        // `Transactions` (bigint amount/fees). Runtime payload unchanged.
        await getTransactionsRepo().save(toTransactionsEntity(rawTransaction))
        return true
    } catch (e) {
        log.error(
            "[insertTransaction] Error inserting transaction (" +
                transaction.hash +
                "): " +
                e,
        )
        return false
    }
}

export async function insertTransactionsFromSync(
    transactions: Transaction[],
): Promise<boolean> {
    if (transactions.length === 0) return true

    const datasourceModule = (await import("src/model/datasource")).default

    const db = await datasourceModule.getInstance()
    const dataSource = db.getDataSource()

    try {
        await dataSource.transaction(async em => {
            const rawTransactions = transactions.map(tx =>
                Transaction.toRawTransaction(tx),
            )
            const { skipped } = await chunkedInsert(
                em,
                Transactions,
                rawTransactions as any[],
            )
            if (skipped > 0) {
                log.warn(
                    `[insertTransactionsFromSync] Skipped ${skipped} duplicate transaction(s)`,
                )
            }
        })

        return true
    } catch (error) {
        log.error(
            `[insertTransactionsFromSync] Transaction batch failed: ${error}`,
        )
        return false
    }
}

/**
 * Sets the failure code of transactions stored as failed with block
 * `blockNumber`, all in one database transaction; a null code removes it.
 * Any other row is left alone.
 */
export async function setFailureCodes(
    blockNumber: number,
    codes: Map<string, string | null>,
): Promise<void> {
    if (codes.size === 0) return
    const datasourceModule = (await import("src/model/datasource")).default
    const dataSource = (await datasourceModule.getInstance()).getDataSource()
    await dataSource.transaction(async em => {
        const rows = await em.find(Transactions, {
            where: {
                hash: In([...codes.keys()]),
                blockNumber,
                status: TRANSACTION_STATUS.FAILED,
            },
        })
        for (const row of rows) {
            const { code: _old, ...rest } = row.attrs ?? {}
            const code = codes.get(row.hash)
            await em.update(
                Transactions,
                { id: row.id },
                { attrs: code === null ? rest : { ...rest, code } },
            )
        }
    })
}
