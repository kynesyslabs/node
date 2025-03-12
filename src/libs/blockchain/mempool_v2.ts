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

    public static async addTransaction(
        transaction: Transaction & { reference_block: number },
    ) {
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
                log.error("Transaction is not coherent: " + tx.hash)
                return {
                    success: false,
                    mempool: [],
                }
            }

            const signatureValid = TxUtils.validateSignature(tx)
            if (!signatureValid) {
                log.error("Transaction signature is not valid: " + tx.hash)
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
        log.only("existingHashes: " + JSON.stringify(existingHashes))
        const incomingSet = {}

        // INFO: Filter unique transactions
        for (const tx of incoming) {
            if (!existingHashes[tx.hash]) {
                incomingSet[tx.hash] = true
                log.only("indexed new tx: " + tx.hash)
            } else {
                log.error("tx already exists: " + tx.hash)
            }
        }

        log.error("incoming: " + JSON.stringify(incoming.map(tx => tx.hash)))
        log.error("incomingSet: " + JSON.stringify(incomingSet))

        // REVIEW: Should we save each tx individually?
        // await this.repo.save(incoming)
        log.only("mempool before save: ")
        const mempoolBeforeSave = await this.getMempool(blockNumber)
        log.only(JSON.stringify(mempoolBeforeSave.map(tx => tx.hash)))

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

        log.only("mempool after save: ")
        const mempoolAfterSave = await this.getMempool(blockNumber)
        log.only(JSON.stringify(mempoolAfterSave.map(tx => tx.hash)))

        const finalPool = await this.getMempool(blockNumber)

        log.error("finalPool: " + JSON.stringify(finalPool.map(tx => tx.hash)))

        // INFO: Redundancy
        // INFO: Return the difference to the caller node
        const final = finalPool.filter(
            tx => tx.blockNumber === blockNumber && !incomingSet[tx.hash],
        )
        log.error("final: " + JSON.stringify(final.map(tx => tx.hash)))

        return {
            success: true,
            mempool: final,
        }
    }
}

await Mempool.init()
