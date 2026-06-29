import { In, LessThan, EntityManager, FindManyOptions } from "typeorm"
import log from "src/utilities/logger"
import Transaction, { toTransactionsEntity } from "./transaction"
import { Transactions } from "src/model/entities/Transactions"
import { L2PSHash } from "src/model/entities/L2PSHashes"
import {
    CHUNK_TRANSACTIONS,
    chunkedInsert,
    getTransactionsRepo,
} from "./chainDb"
import type { TransactionContent } from "@kynesyslabs/demosdk/types"
import type { L2PSHashUpdatePayload, TxStatus } from "./chainTypes"
import Mempool from "./mempool"
import { getSharedState } from "@/utilities/sharedState"
import { getBlockByHash } from "./chainBlocks"
import { txMap as consensusTxMap } from "../consensus/v2/PoRBFT"
import { TRANSACTION_STATUS } from "@/utilities/constants"

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

export async function persistConfirmedTransactionProjection(
    tx: Transaction,
    blockNumber: number,
    transactionalEntityManager: EntityManager,
): Promise<void> {
    const l2psHashPayload = getL2PSHashUpdatePayload(tx)
    if (!l2psHashPayload) {
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

/**
 * Lifecycle status of a transaction by hash.
 *
 * Cheap: 1 mempool lookup, then 1 transactions lookup if not in mempool.
 *
 * "failed" is reserved — currently the node does not record execution
 * failures, so failed txs surface as "unknown".
 */
export async function getTransactionStatus(hash: string): Promise<TxStatus> {
    const inMempool = await Mempool.findByHash(hash)
    if (inMempool) return { state: "pending" }

    const tx = await getTxByHash(hash)
    if (tx) {
        return {
            state: "included",
            blockNumber: tx.blockNumber ?? undefined,
        }
    }

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

                if (!status.has(tx.status)) {
                    log.error(
                        "Transaction status mismatch: " +
                            hash +
                            " " +
                            tx.status,
                    )
                    process.exit(1)
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
                CHUNK_TRANSACTIONS,
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
