import { In, LessThan, EntityManager, FindManyOptions } from "typeorm"
import log from "src/utilities/logger"
import Transaction from "./transaction"
import { Transactions } from "src/model/entities/Transactions"
import { L2PSHash } from "src/model/entities/L2PSHashes"
import {
    CHUNK_TRANSACTIONS,
    chunkedInsertOrIgnore,
    getTransactionsRepo,
} from "./chainDb"
import type { TransactionContent } from "@kynesyslabs/demosdk/types"
import type { L2PSHashUpdatePayload } from "./chainTypes"

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
    status = "confirmed",
): Promise<boolean> {
    log.debug("[insertTransaction] Inserting transaction: " + transaction.hash)
    const rawTransaction = Transaction.toRawTransaction(transaction, status)
    log.debug("[insertTransaction] Raw transaction: ")
    log.debug(JSON.stringify(rawTransaction))
    try {
        await getTransactionsRepo().save(rawTransaction)
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
                Transaction.toRawTransaction(tx, "confirmed"),
            )
            const { skipped } = await chunkedInsertOrIgnore(
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
