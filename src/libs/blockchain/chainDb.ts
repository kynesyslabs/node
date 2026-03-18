import { Repository } from "typeorm"
import log from "src/utilities/logger"
import Datasource from "src/model/datasource"
import { Blocks } from "src/model/entities/Blocks"
import { Transactions } from "src/model/entities/Transactions"

let blocks: Repository<Blocks>
let transactions: Repository<Transactions>

export function getBlocksRepo(): Repository<Blocks> {
    return blocks
}

export function getTransactionsRepo(): Repository<Transactions> {
    return transactions
}

export async function setupChainDb(): Promise<void> {
    const db = await Datasource.getInstance()
    blocks = db.getDataSource().getRepository(Blocks)
    transactions = db.getDataSource().getRepository(Transactions)
}

export async function readSql(sqlQuery: string): Promise<any> {
    try {
        const db = await Datasource.getInstance()
        return await db.getDataSource().query(sqlQuery)
    } catch (err) {
        log.error("[ChainDB] [ ERROR ]: " + JSON.stringify(err))
        throw err
    }
}

export async function writeSql(sqlQuery: string) {
    try {
        const db = await Datasource.getInstance()
        return await db.getDataSource().query(sqlQuery)
    } catch (err) {
        log.error("[ChainDB] [ ERROR ]: " + JSON.stringify(err))
        throw err
    }
}
