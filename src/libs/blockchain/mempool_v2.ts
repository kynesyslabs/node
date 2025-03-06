import { In } from "typeorm"
import Datasource from "@/model/datasource"

import TxUtils from "./transaction"
import log from "src/utilities/logger"
import { MempoolTx } from "@/model/entities/Mempool"
import { Transaction } from "@kynesyslabs/demosdk/types"

export default class Mempool {
    public static async getMempool() {
        const db = await Datasource.getInstance()
        const mempool = await db
            .getDataSource()
            .getRepository(MempoolTx)
            .find({
                order: {
                    timestamp: "ASC",
                },
            })

        return mempool
    }

    public static async getTransactionsByHashes(hashes: string[]) {
        const db = await Datasource.getInstance()
        return await db
            .getDataSource()
            .getRepository(MempoolTx)
            .find({ where: { hash: In(hashes) } })
    }

    public static async addTransaction(transaction: Transaction) {
        const db = await Datasource.getInstance()
        const mempool = await db
            .getDataSource()
            .getRepository(MempoolTx)
            .save({
                ...transaction,
                timestamp: BigInt(transaction.content.timestamp),
                nonce: transaction.content.nonce,
            })

        return mempool
    }

    public static async removeTransactionsByHashes(hashes: string[]) {
        const db = await Datasource.getInstance()
        return await db
            .getDataSource()
            .getRepository(MempoolTx)
            .delete({ hash: In(hashes) })
    }

    public static async receive(incoming: Transaction[]) {
        for (const tx of incoming) {
            const isCoherent = TxUtils.isCoherent(tx)
            if (!isCoherent) {
                log.error("Transaction is not coherent: " + tx.hash)
                return []
            }

            const signatureValid = TxUtils.validateSignature(tx)
            if (!signatureValid) {
                log.error("Transaction signature is not valid: " + tx.hash)
                return []
            }
        }

        const incomingSet = new Set(incoming.map(tx => tx.hash))

        const db = await Datasource.getInstance()
        const finalPool = await db
            .getDataSource()
            .getRepository(MempoolTx)
            .save(incoming)

        // INFO: Redundancy
        // INFO: Return the difference to the caller node
        return finalPool.filter(tx => incomingSet.has(tx.hash))
    }
}
