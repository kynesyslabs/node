import { EntityManager, EntityTarget, ObjectLiteral, Repository } from "typeorm"
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
        log.error(`[ChainDB] [ ERROR ]: ${JSON.stringify(err)}`)
        throw err
    }
}

export async function writeSql(sqlQuery: string) {
    try {
        const db = await Datasource.getInstance()
        return await db.getDataSource().query(sqlQuery)
    } catch (err) {
        log.error(`[ChainDB] [ ERROR ]: ${JSON.stringify(err)}`)
        throw err
    }
}

// Postgres caps bind parameters at 65535 (uint16). Chunk row counts so
// rows * inserted-column-count stays under PG_BIND_BUDGET. If you add a
// column to one of these entities, update its divisor.
const PG_BIND_BUDGET = 65000
export const CHUNK_TRANSACTIONS = Math.floor(PG_BIND_BUDGET / 16) // Transactions: 16 inserted cols
export const CHUNK_MEMPOOL_TX = Math.floor(PG_BIND_BUDGET / 10) // MempoolTx: 10 inserted cols

export interface ChunkedInsertResult {
    inserted: number
    skipped: number
}

/**
 * Bulk INSERT ... ON CONFLICT DO NOTHING in chunks that stay under the
 * Postgres 65,535 bind-parameter wire-protocol limit.
 */
export async function chunkedInsert<T extends ObjectLiteral>(
    runner: EntityManager | Repository<T>,
    target: EntityTarget<T>,
    rows: any[],
    chunkSize: number,
    orUpdate?: {
        conflictTarget?: string | string[]
        overwrite: string[]
    },
): Promise<ChunkedInsertResult> {
    let inserted = 0
    let skipped = 0
    for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize)
        const query = runner
            .createQueryBuilder()
            .insert()
            .into(target)
            .values(chunk)

        if (orUpdate) {
            query.orUpdate(orUpdate.overwrite, orUpdate.conflictTarget)
        } else {
            query.orIgnore()
        }

        const result = await query.execute()
        const chunkInserted = result.identifiers.filter(
            id => id !== undefined,
        ).length
        inserted += chunkInserted
        skipped += chunk.length - chunkInserted
    }

    return { inserted, skipped }
}
