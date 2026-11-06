/**
 * A fake database for insertBlock: each write is staged and becomes durable
 * only when its transaction returns, so a test sees exactly what a commit
 * would leave on disk. `stage` sees every row before it is staged and may
 * refuse it by throwing. Call before importing chainBlocks.
 */

import { mock } from "bun:test"

export type StageCheck = (name: string, rows: unknown[]) => void

function repoFor(staged: Map<string, unknown[]>, name: string, check: StageCheck) {
    const stage = (rows: unknown[]) => {
        check(name, rows)
        staged.set(name, [...(staged.get(name) ?? []), ...rows])
    }
    const query: any = {
        insert: () => query,
        update: () => query,
        set: () => query,
        where: () => query,
        andWhere: () => query,
        values: (rows: unknown[]) => {
            query.rows = rows
            return query
        },
        orIgnore: () => query,
        execute: async () => stage(query.rows ?? []),
    }
    return {
        create: (row: unknown) => row,
        save: async (rows: unknown) => stage(Array.isArray(rows) ? rows : [rows]),
        delete: async () => {},
        insert: async (row: unknown) => stage([row]),
        findOneBy: async () => null,
        find: async () => [],
        findOne: async () => null,
        manager: { connection: { getMetadata: () => ({ columns: [0, 1, 2] }) } },
        createQueryBuilder: () => query,
    }
}

const nameOf = (entity: any) => entity?.name ?? entity?.options?.name ?? String(entity)

function managerFor(staged: Map<string, unknown[]>, check: StageCheck) {
    const em: any = {
        getRepository: (entity: any) => repoFor(staged, nameOf(entity), check),
        save: async (entity: any, rows?: unknown) =>
            repoFor(staged, rows === undefined ? "entity" : nameOf(entity), check).save(
                rows === undefined ? entity : rows,
            ),
        createQueryBuilder: () => repoFor(staged, "IdentityCommitment", check).createQueryBuilder(),
    }
    return em
}

/**
 * Installs the fake database and returns its durable rows, by entity name.
 * `afterCommit` runs once a transaction's rows are durable and may throw, as
 * a COMMIT whose reply is lost does.
 */
export function installFakeBlockDatabase(
    check: StageCheck,
    afterCommit: () => void = () => {},
): Map<string, unknown[]> {
    const durable = new Map<string, unknown[]>()
    const fakeDataSource = {
        transaction: async (work: (em: unknown) => Promise<unknown>) => {
            const staged = new Map<string, unknown[]>()
            const result = await work(managerFor(staged, check))
            for (const [name, rows] of staged) {
                durable.set(name, [...(durable.get(name) ?? []), ...rows])
            }
            afterCommit()
            return result
        },
        getRepository: (entity: any) => repoFor(durable, nameOf(entity), check),
    }
    const datasourceModule = () => ({
        __esModule: true,
        dataSource: fakeDataSource,
        default: { getInstance: async () => ({ getDataSource: () => fakeDataSource }) },
    })
    mock.module("src/model/datasource", datasourceModule)
    mock.module("@/model/datasource", datasourceModule)
    return durable
}

// Only what the insert touches is replaced; every other export stays real.
async function partial(path: string, overrides: Record<string, unknown>) {
    const real = await import(path)
    mock.module(path, () => ({ ...real, ...overrides }))
}

/**
 * Replaces what insertBlock calls besides the database, writing the block
 * row through the blocks repository's target.
 */
export async function stubBlockInsertCollaborators(
    extra: Record<string, Record<string, unknown>> = {},
): Promise<void> {
    await partial("src/libs/blockchain/chainDb", {
        getBlocksRepo: () => ({ target: { name: "Blocks" }, findOneBy: async () => null }),
        chunkedInsert: async (em: any, entity: any, rows: unknown[]) => {
            await em.getRepository(entity).save(rows)
            return { skipped: 0 }
        },
    })
    await partial("@/features/zk/merkle/updateMerkleTreeAfterBlock", {
        updateMerkleTreeAfterBlock: async () => 0,
    })
    await partial("src/libs/blockchain/routines/tallyUpgradeVotes", { default: async () => {} })
    await partial("src/libs/blockchain/routines/applyNetworkUpgrade", { default: async () => {} })
    await partial("src/libs/blockchain/routines/loadNetworkParameters", { loadNetworkParameters: async () => {} })
    await partial("src/libs/consensus/stakedSet", { getStakedSet: async () => new Set() })
    for (const [path, overrides] of Object.entries(extra)) await partial(path, overrides)
}
