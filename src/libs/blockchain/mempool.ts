import {
    EntityManager,
    FindManyOptions,
    In,
    LessThanOrEqual,
    QueryFailedError,
    Repository,
} from "typeorm"
import Datasource from "@/model/datasource"

import TxUtils from "./transaction"
import log from "src/utilities/logger"
import { MempoolTx } from "@/model/entities/Mempool"
import { Transaction } from "@kynesyslabs/demosdk/types"
import SecretaryManager from "../consensus/v2/types/secretaryManager"
import Chain from "./chain"
import { getSharedState } from "@/utilities/sharedState"

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

    public static async addTransaction(
        transaction: Transaction & { reference_block: number },
        // blockRef?: number,
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

        const blockNumber = getSharedState.lastBlockNumber + 2

        // INFO: If we're in consensus, move tx to next block
        // if (getSharedState.inConsensusLoop) {
        //     blockNumber = SecretaryManager.lastBlockRef + 1
        // } else {
        //     blockNumber = getSharedState.lastBlockNumber + 1
        // }

        try {
            const saved = await this.repo.save({
                ...transaction,
                timestamp: BigInt(transaction.content.timestamp),
                nonce: transaction.content.nonce,
                blockNumber: blockNumber,
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
        // REVIEW: CRITICAL FIX - Support transactional entity manager for atomic operations
        // When called within a transaction, use the transactional manager to ensure atomicity
        const repo = transactionalEntityManager
            ? transactionalEntityManager.getRepository(this.repo.target)
            : this.repo
        return await repo.delete({ hash: In(hashes) })
    }

    public static async receive(incoming: Transaction[]) {
        // if (!getSharedState.inConsensusLoop) {
        //     return {
        //         success: false,
        //         mempool: [],
        //     }
        // }

        // INFO: Transactions not to send back back
        const noSendBackTxs = new Map<string, string>()

        const blockNumber = SecretaryManager.lastBlockRef
        const existingHashes = await this.getMempoolHashMap(blockNumber)

        const unseenTransactions = incoming.filter(
            tx => !existingHashes[tx.hash],
        )

        if (unseenTransactions.length === 0) {
            const finalPool = await this.getMempool(blockNumber)
            const final = finalPool.filter(tx => tx.blockNumber === blockNumber)
            return {
                success: true,
                mempool: final,
            }
        }

        const validateOne = async (
            tx: Transaction,
        ): Promise<Transaction | null> => {
            const isCoherent = TxUtils.isCoherent(tx)
            if (!isCoherent) {
                log.error(
                    "[Mempool.receive] Transaction is not coherent: " + tx.hash,
                )
                return null
            }

            const { success: signatureValid } =
                await TxUtils.validateSignature(tx)
            if (!signatureValid) {
                log.error(
                    "[Mempool.receive] Transaction signature is not valid: " +
                        tx.hash,
                )
                return null
            }

            return tx
        }

        const BATCH_SIZE = 16
        const validationResults: (Transaction | null)[] = []
        for (let i = 0; i < unseenTransactions.length; i += BATCH_SIZE) {
            const batch = unseenTransactions.slice(i, i + BATCH_SIZE)
            const results = await Promise.all(batch.map(validateOne))
            validationResults.push(...results)
        }

        const validTransactions = validationResults.filter(
            (tx): tx is Transaction => tx !== null,
        )

        for (const tx of validTransactions) {
            noSendBackTxs.set(tx.hash, tx.hash)
        }

        if (validTransactions.length > 0) {
            try {
                const insertResult = await this.repo
                    .createQueryBuilder()
                    .insert()
                    .into(MempoolTx)
                    .values(validTransactions)
                    .orIgnore()
                    .execute()

                const insertedCount = insertResult.identifiers.length
                log.debug(
                    `[Mempool.receive] Inserted ${insertedCount}/${validTransactions.length} transactions`,
                )
            } catch (error) {
                log.error("[Mempool.receive] Error saving received mempool:")
                console.error(error)
            }
        }

        const finalPool = await this.getMempool(blockNumber)

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
