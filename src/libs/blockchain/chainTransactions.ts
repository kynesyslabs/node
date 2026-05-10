import { ILike, In, LessThan, EntityManager, FindManyOptions } from "typeorm"
import log from "src/utilities/logger"
import Transaction, { toTransactionsEntity } from "./transaction"
import { Transactions } from "src/model/entities/Transactions"
import { L2PSHash } from "src/model/entities/L2PSHashes"
import { handleError } from "src/errors"
import { getTransactionsRepo } from "./chainDb"
import Mempool from "./mempool"
import type { TransactionContent } from "@kynesyslabs/demosdk/types"
import type { L2PSHashUpdatePayload, TxStatus } from "./chainTypes"

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
        const rawTx = await getTransactionsRepo().findOneBy({
            hash: ILike(hash),
        })

        if (!rawTx) {
            return null
        }

        return Transaction.fromRawTransaction(rawTx)
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
    const { getBlockByHash } = await import("./chainBlocks")
    const block = await getBlockByHash(blockHash)
    return await getTransactionsFromHashes(block.content.ordered_transactions)
}

export async function getTransactionFromHash(
    hash: string,
): Promise<Transaction | null> {
    const rawTx = await getTransactionsRepo().findOneBy({ hash: ILike(hash) })
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
    status = "confirmed",
): Promise<boolean> {
    log.debug(
        "[insertTransaction] Inserting transaction: " + transaction.hash,
    )
    const rawTransaction = Transaction.toRawTransaction(transaction, status)
    log.debug("[insertTransaction] Raw transaction: ")
    log.debug(JSON.stringify(rawTransaction))
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
    for (const tx of transactions) {
        try {
            await insertTransaction(tx)
        } catch (error) {
            handleError(error, "CHAIN", { source: "ChainDB sync insertion" })
        }
    }

    return true
}
