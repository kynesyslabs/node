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
import { TransactionClassification } from "@/libs/consensus/petri/types/classificationTypes"
import { classifyTransaction } from "@/libs/consensus/petri/classifier/transactionClassifier"
import { executeSpeculatively } from "@/libs/consensus/petri/execution/speculativeExecutor"

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

        let blockNumber: number = blockRef ?? undefined

        // INFO: If we're in consensus, move tx to next block
        if (getSharedState.inConsensusLoop && !blockNumber) {
            blockNumber = SecretaryManager.lastBlockRef + 1
        }

        if (!blockNumber) {
            blockNumber = (await Chain.getLastBlockNumber()) + 1
        }

        try {
            // REVIEW: Petri Consensus — classify at insertion time (gated by feature flag)
            let classification: string | null = null
            let deltaHash: string | null = null
            if (getSharedState.petriConsensus) {
                const result = await classifyTransaction(transaction)
                classification = result.classification

                if (result.classification === TransactionClassification.TO_APPROVE) {
                    const specResult = await executeSpeculatively(
                        transaction,
                        result.gcrEdits,
                    )
                    if (specResult.success && specResult.delta) {
                        deltaHash = specResult.delta.hash
                    }
                }

                log.debug(
                    `[Mempool] Petri classification for ${transaction.hash}: ${classification}` +
                    (deltaHash ? ` (delta=${deltaHash.substring(0, 16)}...)` : ""),
                )
            }

            const saved = await this.repo.save({
                ...transaction,
                timestamp: BigInt(transaction.content.timestamp),
                nonce: transaction.content.nonce,
                blockNumber: blockNumber,
                classification,
                delta_hash: deltaHash,
            })

            return {
                confirmationBlock: saved.blockNumber,
                error: "",
            }
        } catch (error) {
            let message = "Error: Failed to add transaction to mempool"

            if (error instanceof QueryFailedError) {
                log.error("Error saving tx: " + transaction.hash)
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
        for (const tx of incoming) {
            const isCoherent = TxUtils.isCoherent(tx)
            if (!isCoherent) {
                log.error(
                    "[Mempool.receive] Transaction is not coherent: " + tx.hash,
                )
                return {
                    success: false,
                    mempool: [],
                }
            }

            const signatureValid = TxUtils.validateSignature(tx)
            if (!signatureValid) {
                log.error(
                    "[Mempool.receive] Transaction signature is not valid: " +
                    tx.hash,
                )
                return {
                    success: false,
                    mempool: [],
                }
            }
        }

        if (!getSharedState.inConsensusLoop) {
            return {
                success: false,
                mempool: [],
            }
        }
        const blockNumber = SecretaryManager.lastBlockRef

        const existingHashes = await this.getMempoolHashMap(blockNumber)
        const incomingSet = {}

        // INFO: Filter unique transactions
        for (const tx of incoming) {
            if (!existingHashes[tx.hash]) {
                incomingSet[tx.hash] = true
            } else {
                log.error("tx already exists: " + tx.hash)
            }
        }

        // REVIEW: Should we save each tx individually?
        // await this.repo.save(incoming)
        for (const tx of incoming) {
            try {
                await this.repo.save(tx)
            } catch (error) {
                if (error instanceof QueryFailedError) {
                    log.error("Error saving tx: " + tx.hash)
                    log.error(error.message)
                }
            }
        }
        const finalPool = await this.getMempool(blockNumber)

        // INFO: Redundancy
        // INFO: Return the difference to the caller node
        const final = finalPool.filter(
            tx => tx.blockNumber === blockNumber && !incomingSet[tx.hash],
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

    // REVIEW: Petri Consensus classification queries (Phase 1)

    /**
     * Get mempool transactions filtered by Petri classification.
     */
    public static async getByClassification(
        classification: TransactionClassification,
        blockNumber?: number,
    ): Promise<MempoolTx[]> {
        const where: Record<string, unknown> = { classification }
        if (blockNumber) {
            where.blockNumber = LessThanOrEqual(blockNumber)
        }
        return await this.repo.find({
            where,
            order: { timestamp: "ASC" },
        })
    }

    /**
     * Get all PRE_APPROVED transactions, optionally filtered by block number.
     */
    public static async getPreApproved(
        blockNumber?: number,
    ): Promise<MempoolTx[]> {
        return this.getByClassification(
            TransactionClassification.PRE_APPROVED,
            blockNumber,
        )
    }

    /**
     * Update classification and optional delta hash for a transaction.
     */
    public static async updateClassification(
        txHash: string,
        classification: TransactionClassification,
        deltaHash?: string,
    ): Promise<void> {
        const update: Record<string, unknown> = { classification }
        if (deltaHash !== undefined) {
            update.delta_hash = deltaHash
        }
        // REVIEW: Petri Phase 5 — record soft finality timestamp when PRE_APPROVED
        if (classification === TransactionClassification.PRE_APPROVED) {
            update.soft_finality_at = Date.now()
        }
        await this.repo.update({ hash: txHash }, update)
    }
}

// await Mempool.init()
