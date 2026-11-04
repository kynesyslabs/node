import { beforeEach, describe, expect, it, mock } from "bun:test"

/**
 * The block insert writes what peers serve outside the block hash (attrs,
 * proposer, next proposer) and, for every l2ps_hash_update a block lists,
 * failed or not, an l2ps_hashes row from the transaction body. A value
 * Postgres refuses in any of them failed the commit on every node. The fake
 * database below refuses what Postgres refuses, column by column.
 */

const durable = new Map<string, unknown[]>()

const refuses = (value: unknown, jsonb: boolean): boolean => {
    if (typeof value === "string") return value.includes("\u0000") || (jsonb && !value.isWellFormed())
    if (typeof value !== "object" || value === null) return false
    return Object.entries(value).some(([k, v]) => refuses(k, jsonb) || refuses(v, jsonb))
}

/** What Postgres would refuse in a row of `name`, by column type. */
function postgresRefusal(name: string, row: Record<string, unknown>): string | null {
    // "key": indexed text, whose b-tree entry Postgres caps at 2704 bytes
    // (text that does not compress, as here, keeps about its length).
    const columns: Record<string, Record<string, "text" | "key" | "jsonb" | "int4">> = {
        Blocks: { proposer: "text", next_proposer: "text", status: "text", hash: "key", attrs: "jsonb" },
        L2PSHash: { l2ps_uid: "key", hash: "text", transaction_count: "int4" },
        Transactions: { hash: "key", from_ed25519_address: "key", to: "key" },
    }
    const tooLong = (value: unknown) => typeof value === "string" && Buffer.byteLength(value) > 2704
    for (const [column, type] of Object.entries(columns[name] ?? {})) {
        const value = row[column]
        if (
            type === "int4"
                ? !Number.isInteger(Number(value))
                : refuses(value, type === "jsonb") || (type === "key" && tooLong(value))
        ) {
            return `${name}.${column}`
        }
    }
    return null
}

function repoFor(staged: Map<string, unknown[]>, name: string) {
    const stage = (rows: unknown[]) => {
        for (const row of rows) {
            const refusal = postgresRefusal(name, row as Record<string, unknown>)
            if (refusal) throw new Error(`invalid input for ${refusal}`)
        }
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
        manager: { connection: { getMetadata: () => ({ columns: [0, 1, 2] }) } },
        createQueryBuilder: () => query,
    }
}

const nameOf = (entity: any) => entity?.name ?? entity?.options?.name ?? String(entity)

function managerFor(staged: Map<string, unknown[]>) {
    const em: any = {
        getRepository: (entity: any) => repoFor(staged, nameOf(entity)),
        save: async (entity: any, rows?: unknown) =>
            repoFor(staged, rows === undefined ? "entity" : nameOf(entity)).save(
                rows === undefined ? entity : rows,
            ),
        createQueryBuilder: () => repoFor(staged, "IdentityCommitment").createQueryBuilder(),
    }
    return em
}

const fakeDataSource = {
    transaction: async (work: (em: unknown) => Promise<unknown>) => {
        const staged = new Map<string, unknown[]>()
        const result = await work(managerFor(staged))
        for (const [name, rows] of staged) {
            durable.set(name, [...(durable.get(name) ?? []), ...rows])
        }
        return result
    },
    getRepository: (entity: any) => repoFor(durable, nameOf(entity)),
}

const datasourceModule = () => ({
    __esModule: true,
    dataSource: fakeDataSource,
    default: { getInstance: async () => ({ getDataSource: () => fakeDataSource }) },
})
mock.module("src/model/datasource", datasourceModule)
mock.module("@/model/datasource", datasourceModule)
mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug: () => {}, info: () => {}, warn: () => {}, warning: () => {}, error: () => {}, only: () => {}, custom: () => {} },
}))

const partial = async (path: string, overrides: Record<string, unknown>) => {
    const real = await import(path)
    mock.module(path, () => ({ ...real, ...overrides }))
}
await partial("./chainDb", {
    getBlocksRepo: () => ({ target: { name: "Blocks" }, findOneBy: async () => null }),
    chunkedInsert: async (em: any, entity: any, rows: unknown[]) => {
        await em.getRepository(entity).save(rows)
        return { skipped: 0 }
    },
})
await partial("@/features/zk/merkle/updateMerkleTreeAfterBlock", {
    updateMerkleTreeAfterBlock: async () => 0,
})
await partial("./routines/tallyUpgradeVotes", { default: async () => {} })
await partial("./routines/applyNetworkUpgrade", { default: async () => {} })
await partial("./routines/loadNetworkParameters", { loadNetworkParameters: async () => {} })
await partial("src/libs/consensus/stakedSet", { getStakedSet: async () => new Set() })
const { insertBlock } = await import("./chainBlocks")
const { getSharedState } = await import("src/utilities/sharedState")
const { BlockInvalidError } = await import("@/errors")

getSharedState.forkConfig = {
    ...getSharedState.forkConfig,
    osDenomination: { activationHeight: null },
    gasFeeSeparation: { activationHeight: null },
} as any

const HEIGHT = 9
const TX_HASH = "0xtx"

function block(overrides: Record<string, unknown> = {}): any {
    return {
        number: HEIGHT,
        hash: "0xblock",
        proposer: "ab".repeat(32),
        next_proposer: "cd".repeat(32),
        status: "confirmed",
        validation_data: { signatures: {} },
        content: { ordered_transactions: [TX_HASH], timestamp: 1_700_000_000 },
        attrs: {},
        ...overrides,
    }
}

/** An l2ps_hash_update that failed in its block: its row is written anyway. */
const hashUpdate = (payload: Record<string, unknown>): any => ({
    hash: TX_HASH,
    status: "failed",
    signature: null,
    ed25519_signature: null,
    content: {
        type: "l2ps_hash_update",
        from: "0xaa",
        to: "0xaa",
        from_ed25519_address: "0xaa",
        amount: "0",
        nonce: 2,
        timestamp: 1_700_000_000,
        transaction_fee: { network_fee: "0", rpc_fee: "0", additional_fee: "0" },
        data: ["l2ps_hash_update", { l2ps_uid: "net", consolidated_hash: "0xc", transaction_count: 3, ...payload }],
        gcr_edits: [],
    },
    attrs: { code: "TX_EXECUTE_FAILED" },
    blockNumber: HEIGHT,
})

beforeEach(() => {
    durable.clear()
    getSharedState.lastBlockNumber = HEIGHT - 1
    getSharedState.fastSyncCount = 0
})

describe("block attrs a peer served", () => {
    it("are stored with U+0000 and unpaired surrogates replaced, and the block commits", async () => {
        await insertBlock(block({ attrs: { gcrAppliedTxs: ["a\u0000"], ["\ud800"]: 1 } }), [hashUpdate({})])
        const [stored] = durable.get("Blocks") as Array<{ attrs: unknown }>
        expect(stored.attrs).toEqual({ gcrAppliedTxs: ["a�"], ["�"]: 1 })
    })
})

describe("a proposer Postgres cannot store", () => {
    it("is refused before anything is written", async () => {
        const insert = insertBlock(block({ proposer: "ab".repeat(32) + "\u0000" }), [hashUpdate({})])
        await expect(insert).rejects.toBeInstanceOf(BlockInvalidError)
        expect(durable.size).toBe(0)
    })
})

describe("the l2ps_hashes row of a failed l2ps_hash_update", () => {
    it("is written when it can be", async () => {
        await insertBlock(block(), [hashUpdate({})])
        expect(durable.get("L2PSHash")).toMatchObject([{ l2ps_uid: "net", hash: "0xc", transaction_count: 3 }])
    })

    for (const [name, payload] of [
        ["U+0000 in the uid", { l2ps_uid: "net\u0000" }],
        ["U+0000 in the hash", { consolidated_hash: "0x\u0000" }],
        ["a count that is not an integer", { transaction_count: 1.5 }],
        ["a uid too long for its primary key", { l2ps_uid: Array.from({ length: 3000 }, (_, i) => String.fromCharCode(0x21 + ((i * 7919) % 89))).join("") }],
    ] as const) {
        it(`is skipped, not failing the block: ${name}`, async () => {
            await insertBlock(block(), [hashUpdate(payload)])
            expect(durable.get("Blocks")?.length).toBe(1)
            expect(durable.get("Transactions")?.length).toBe(1)
            expect(durable.has("L2PSHash")).toBe(false)
        })
    }
})
