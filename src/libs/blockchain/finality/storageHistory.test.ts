/**
 * The storage undo log as the block write path keeps it: each block logs,
 * in its own transaction and before its writes, the record every program it
 * touches had before it. The log keeps the last 64 blocks, drops the rows of
 * a branch replaced at a height, and with it the root each recent block
 * committed rebuilds from the live table.
 */

import { beforeEach, describe, expect, it, jest, mock } from "bun:test"
import type { FindOperator } from "typeorm"
import { GCRStorageProgram } from "@/model/entities/GCRv2/GCR_StorageProgram"
import { StorageProgramHistory } from "@/model/entities/StorageProgramHistory"
import { SparseMerkleTree } from "@/libs/crypto/merkle/sparse"
import { CreateStorageProgramHistory1793923200000 } from "@/migrations/1793923200000-CreateStorageProgramHistory"

mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() },
}))

interface HistoryRow {
    block: number
    storageAddress: string
    record: unknown
}

/** What the database holds: jsonb and row copies, never the objects written. */
let table = new Map<string, Record<string, unknown>>()
let history: HistoryRow[] = []
const stored = <T>(value: T): T => JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)))

function matches(value: unknown, op: FindOperator<unknown> | unknown): boolean {
    if (!op || typeof op !== "object" || !("type" in (op as object))) return value === op
    const { type, value: bound } = op as FindOperator<any>
    switch (type) {
        case "in":
            return (bound as unknown[]).includes(value)
        case "between":
            return (value as number) >= bound[0] && (value as number) <= bound[1]
        case "moreThanOrEqual":
            return (value as number) >= bound
        case "moreThan":
            return (value as number) > bound
        case "lessThan":
            return (value as number) < bound
        default:
            throw new Error(`unexpected operator ${type}`)
    }
}

const programRepo = {
    find: async ({ where }: any) =>
        [...table.values()].filter(r => matches(r.storageAddress, where.storageAddress)).map(r => Object.assign(new GCRStorageProgram(), stored(r))),
    save: async (rows: GCRStorageProgram[]) => {
        for (const r of rows) table.set(r.storageAddress, stored({ ...r }))
    },
    delete: async ({ storageAddress }: any) => {
        for (const address of [...table.keys()]) if (matches(address, storageAddress)) table.delete(address)
    },
}

const historyRepo = {
    createQueryBuilder: () => {
        const qb: any = {
            insert: () => qb,
            values: (rows: HistoryRow[]) => ((qb.rows = rows), qb),
            orIgnore: () => ((qb.ignore = true), qb),
            execute: async () => {
                for (const row of qb.rows) {
                    const exists = history.some(h => h.block === row.block && h.storageAddress === row.storageAddress)
                    if (exists && !qb.ignore) throw new Error("duplicate key")
                    if (!exists) history.push(stored(row))
                }
            },
        }
        return qb
    },
    delete: async ({ block }: any) => {
        history = history.filter(h => !matches(h.block, block))
    },
    find: async ({ where, order }: any) => {
        expect(order).toEqual({ block: "DESC", storageAddress: "ASC" })
        return history
            .filter(h => matches(h.block, where.block))
            .sort((a, b) => b.block - a.block || (a.storageAddress < b.storageAddress ? -1 : 1))
            .map(stored)
    },
}

const em: any = {
    getRepository: (target: unknown) => {
        if (target === GCRStorageProgram) return programRepo
        if (target === StorageProgramHistory) return historyRepo
        throw new Error(`unexpected repository ${String((target as { name?: string })?.name)}`)
    },
}
const fakeDataSource = {
    transaction: async (work: (m: unknown) => Promise<unknown>) => await work(em),
    getRepository: (target: unknown) => em.getRepository(target),
}
const datasourceModule = () => ({
    __esModule: true,
    dataSource: fakeDataSource,
    default: { getInstance: async () => ({ getDataSource: () => fakeDataSource }) },
})
mock.module("src/model/datasource", datasourceModule)
mock.module("@/model/datasource", datasourceModule)

const handleGCR = (await import("@/libs/blockchain/gcr/handleGCR")).default
const {
    STORAGE_HISTORY_BLOCKS,
    oldestProvableBlock,
    pruneStorageHistory,
    readStorageHistory,
    recordStorageHistory,
    resetStorageHistory,
} = await import("./storageHistory")
const { StorageProgramsRoot } = await import("./storageRoot")
const { storageProgramKey, storageProgramLeafHex, storageProgramRecord } = await import("./storageRecord")

function program(address: string, overrides: Record<string, unknown> = {}): GCRStorageProgram {
    return Object.assign(new GCRStorageProgram(), {
        storageAddress: address,
        owner: "0xaa",
        programName: `p-${address}`,
        encoding: "json",
        data: { v: 1 },
        sizeBytes: 7,
        acl: { mode: "owner" },
        metadata: null,
        storageLocation: "onchain",
        ipfsCid: null,
        salt: null,
        createdByTx: "0xc1",
        lastModifiedByTx: "0xc1",
        totalFeesPaid: 3n,
        isDeleted: false,
        interactionTxs: ["0xc1"],
        deletedByTx: null,
        smtLeaf: null,
        ...overrides,
    })
}

const caches = (programs: [string, GCRStorageProgram | null][]): any => ({
    accounts: new Map(),
    storagePrograms: new Map(programs),
    tlsNotaries: new Map(),
    atomicWorks: new Map(),
    resourceSlots: new Map(),
})

/** One block's insert transaction as chainBlocks.insertBlock runs it. */
async function insertBlock(block: number, ...sets: [string, GCRStorageProgram | null][][]) {
    await resetStorageHistory(em, block)
    for (const set of sets) {
        await handleGCR.pendingWrite(caches(set), new Map()).write(em, block)
    }
}

const rootOfTable = () =>
    SparseMerkleTree.build(
        [...table.values()].map(r => ({ key: storageProgramKey(r.storageAddress as string), valueHash: storageProgramLeafHex(r as any) })),
    ).rootHex

const reader = {
    read: async (work: any) =>
        await work({
            leaves: async () =>
                [...table.values()].map(r => ({ storageAddress: r.storageAddress, smtLeaf: r.smtLeaf, version: "1" })),
            rows: async (addresses: string[]) => addresses.flatMap(a => (table.has(a) ? [stored(table.get(a))] : [])),
            history: (from: number, to: number) => readStorageHistory(em, from, to),
        }),
    fillLeaves: async () => {},
}

const A = "stor-a"
const B = "stor-b"
const C = "stor-c"

beforeEach(() => {
    table = new Map()
    history = []
})

describe("storage undo log", () => {
    it("creates its table with a (block, storageAddress) key and a nullable record", async () => {
        const queries: string[] = []
        await new CreateStorageProgramHistory1793923200000().up({ query: async (q: string) => void queries.push(q) } as any)
        expect(queries[0]).toContain("\"storage_program_history\"")
        expect(queries[0]).toMatch(/"record" jsonb,/)
        expect(queries[0]).toContain("PRIMARY KEY (\"block\", \"storageAddress\")")
    })

    it("logs each touched program's record from before the block, null for a program it created", async () => {
        await insertBlock(1, [[A, program(A)]])
        const a1 = storageProgramRecord(table.get(A) as any)
        await insertBlock(2, [[A, program(A, { data: { v: 2 } })], [B, program(B)]])
        expect(history).toEqual([
            { block: 1, storageAddress: A, record: null },
            { block: 2, storageAddress: A, record: a1 },
            { block: 2, storageAddress: B, record: null },
        ])
    })

    it("keeps only the first touch of a program within a block", async () => {
        // Created and then written by two sets of one block: no block ever
        // committed the created-but-unwritten state.
        await insertBlock(3, [[C, program(C)]], [[C, program(C, { data: { v: 9 } })]])
        expect(history).toEqual([{ block: 3, storageAddress: C, record: null }])
        expect((table.get(C) as any).data).toEqual({ v: 9 })
    })

    it("logs hard and soft deletes with the record they removed", async () => {
        await insertBlock(1, [[A, program(A)], [B, program(B)]])
        const a = storageProgramRecord(table.get(A) as any)
        const b = storageProgramRecord(table.get(B) as any)
        await insertBlock(2, [[A, null], [B, program(B, { isDeleted: true })]])
        expect(history.filter(h => h.block === 2)).toEqual([
            { block: 2, storageAddress: A, record: a },
            { block: 2, storageAddress: B, record: b },
        ])
    })

    it("logs nothing for a write that is not a block's", async () => {
        await handleGCR.saveGCREditChanges(caches([[A, program(A)]]), [])
        await recordStorageHistory(em, 4, [])
        expect(history).toEqual([])
        expect(table.has(A)).toBe(true)
    })

    it("keeps the last 64 blocks", async () => {
        const tip = STORAGE_HISTORY_BLOCKS + 10
        for (let block = 1; block <= tip; block++) {
            await insertBlock(block, [[A, program(A, { data: { block } })]])
        }
        const blocks = history.map(h => h.block)
        expect(Math.min(...blocks)).toBe(oldestProvableBlock(tip))
        expect(Math.max(...blocks)).toBe(tip)
        expect(blocks.length).toBe(STORAGE_HISTORY_BLOCKS)
        expect(oldestProvableBlock(tip)).toBe(tip - 63)
        expect(oldestProvableBlock(10)).toBe(1)
    })

    it("drops a replaced branch's rows when a block is inserted again at its height", async () => {
        await insertBlock(1, [[A, program(A)]])
        await insertBlock(2, [[A, program(A, { data: { v: 2 } })]])
        await insertBlock(3, [[B, program(B)]])
        // Block 2 of another branch: the old branch's state was rolled back,
        // so its rows of blocks 2 and 3 describe a chain no longer followed.
        table.delete(B)
        table.set(A, stored({ ...program(A), smtLeaf: storageProgramLeafHex(program(A)) }))
        await insertBlock(2, [[C, program(C)]])
        expect(history).toEqual([
            { block: 1, storageAddress: A, record: null },
            { block: 2, storageAddress: C, record: null },
        ])
    })

    it("drops rows above a height when the chain is pruned or the node boots behind them", async () => {
        await insertBlock(1, [[A, program(A)]])
        await insertBlock(2, [[B, program(B)]])
        await pruneStorageHistory(1)
        expect(history.map(h => h.block)).toEqual([1])
        await pruneStorageHistory(0)
        expect(history).toEqual([])
    })

    it("rebuilds the root every recent block committed from the live table", async () => {
        const committed: string[] = [rootOfTable()]
        const blocks: [string, GCRStorageProgram | null][][][] = [
            [[[A, program(A)], [B, program(B)]]],
            [[[A, program(A, { data: { v: 2 } })]]],
            [],
            [[[B, null], [C, program(C)]], [[C, program(C, { data: { v: 3 } })]]],
            [[[A, program(A, { isDeleted: true, data: null })]]],
        ]
        for (const [i, sets] of blocks.entries()) {
            await insertBlock(i + 1, ...sets)
            committed.push(rootOfTable())
        }
        const tip = blocks.length
        const root = new StorageProgramsRoot(reader as any)
        for (let block = 1; block <= tip; block++) {
            // Block `block` commits the root of the state after block - 1.
            const proved = await root.prove([A, B, C], { fromBlock: block, toBlock: tip })
            expect(proved.root).toBe(committed[block - 1])
        }
        expect((await root.prove([A], { fromBlock: tip + 1, toBlock: tip })).root).toBe(committed[tip])
    })
})
