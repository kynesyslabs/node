import { FindManyOptions, In, QueryFailedError, Repository } from "typeorm"
import Datasource from "@/model/datasource"

import TxUtils from "./transaction"
import log from "src/utilities/logger"
import { MempoolTx } from "@/model/entities/Mempool"
import { Transaction } from "@kynesyslabs/demosdk/types"
import SecretaryManager from "../consensus/v2/types/secretaryManager"
import Chain from "./chain"

export default class Mempool {
    public static repo: Repository<MempoolTx> = null
    public static async init() {
        const db = await Datasource.getInstance()
        this.repo = db.getDataSource().getRepository(MempoolTx)
    }

    /**
     * Returns the mempool. If `blockNumber` is not provided, returns all transactions.
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
                blockNumber: blockNumber,
            }
        }

        return (await this.repo.find(options)) as (Transaction & {
            reference_block: number
        })[]
    }

    /**
     * Returns a map of mempool hashes to null (for lookup only)
     */
    public static async getMempoolHashMap(blockNumber: number) {
        const hashes = await this.repo.find({
            select: ["hash"],
            where: { blockNumber: blockNumber },
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

        let blockNumber: number
        const manager = SecretaryManager.getInstance()

        // INFO: If we're in consensus, move tx to next block
        if (manager.shard?.blockRef) {
            blockNumber = manager.shard.blockRef + 1
        }

        if (!blockNumber) {
            blockNumber = (await Chain.getLastBlockNumber()) + 1
        }

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
            let message: string = "Error: Failed to add transaction to mempool"

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

    public static async removeTransactionsByHashes(hashes: string[]) {
        return await this.repo.delete({ hash: In(hashes) })
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

        const manager = SecretaryManager.getInstance()
        const blockNumber = manager.shard?.blockRef

        if (!blockNumber) {
            return {
                success: false,
                mempool: [],
            }
        }

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
}

await Mempool.init()
