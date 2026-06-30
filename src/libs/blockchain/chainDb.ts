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

// Postgres caps bind parameters at 65535 (uint16) per query
const PG_BIND_BUDGET = 65000

/**
 * Largest row count that keeps a single bulk INSERT under the Postgres
 * bind-parameter cap, derived from the target entity's physical column count.
 */
export function maxRowsPerInsert<T extends ObjectLiteral>(
    runner: EntityManager | Repository<T>,
    target: EntityTarget<T>,
): number {
    const manager = runner instanceof EntityManager ? runner : runner.manager
    const columnCount = manager.connection.getMetadata(target).columns.length
    return Math.max(1, Math.floor(PG_BIND_BUDGET / columnCount))
}

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
    orUpdate?: {
        conflictTarget?: string | string[]
        overwrite: string[]
    },
): Promise<ChunkedInsertResult> {
    let inserted = 0
    let skipped = 0
    const chunkSize = maxRowsPerInsert(runner, target)
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
