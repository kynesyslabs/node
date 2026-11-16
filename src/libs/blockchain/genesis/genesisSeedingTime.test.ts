/**
 * Every validator seeds block 0's accounts on its own, at its own moment.
 * The rows must still be the same bytes everywhere: stamped with block 0's
 * time, never the seeding node's clock.
 */

import { afterEach, describe, expect, it, mock, setSystemTime, spyOn } from "bun:test"

const GENESIS_SEC = 1_794_700_800
const GENESIS_ISO = new Date(GENESIS_SEC * 1000).toISOString()

let seededAt: Date | null = null
mock.module("src/libs/blockchain/genesis/restoreGenesisState", () => ({
    restoreGenesisState: async () => {
        await Promise.resolve()
        const { applyTime } = await import("src/libs/blockchain/gcr/applyTime")
        seededAt = applyTime()
        return true
    },
}))
mock.module("src/libs/blockchain/genesis/loadSnapshot", () => ({
    loadSnapshot: async () => ({ available: true }),
}))
mock.module("src/libs/blockchain/genesis/buildGenesisBlock", () => ({
    buildGenesisBlock: () => ({
        genesisBlock: { hash: "h0", content: { timestamp: GENESIS_SEC } },
        genesisTx: {},
    }),
}))
mock.module("src/libs/consensus/v2/routines/getCommonValidatorSeed", () => ({
    __esModule: true,
    default: async () => ({ commonValidatorSeed: "seed" }),
}))
const fakeDataSource = { transaction: async (w: any) => w({}), getRepository: () => ({}) }
const datasourceModule = () => ({
    __esModule: true,
    dataSource: fakeDataSource,
    default: { getInstance: async () => ({ getDataSource: () => fakeDataSource }) },
})
mock.module("src/model/datasource", datasourceModule)
mock.module("@/model/datasource", datasourceModule)

const realChainBlocks = { ...(await import("src/libs/blockchain/chainBlocks")) }
mock.module("src/libs/blockchain/chainBlocks", () => ({ ...realChainBlocks, insertBlock: async () => {} }))

const { mergeGenesisBalances } = await import("./mergeGenesisBalances")
const { runGasFeeSeparationMigration } = await import("@/forks/migrations/gasFeeSeparation")
const { withBlockTime } = await import("../gcr/applyTime")
const chainBlocks = await import("../chainBlocks")
spyOn(chainBlocks, "insertBlock").mockImplementation(async () => undefined as any)
const { generateGenesisBlock } = await import("../chainGenesis")

const ALICE = "0x" + "a1".repeat(32)
const BOB = "0x" + "b2".repeat(32)
const TREASURY = "0x" + "7e".repeat(32)

function memoryRepo() {
    const rows = new Map<string, any>()
    rows.set(BOB, { pubkey: BOB, balance: 1n })
    const repo = {
        findOne: async ({ where }: any) => (rows.has(where.pubkey) ? { ...rows.get(where.pubkey) } : null),
        save: async (row: any) => rows.set(row.pubkey, structuredClone(row)),
        create: (row: any) => row,
    }
    return { em: { getRepository: () => repo } as any, rows }
}

function queryLog() {
    const writes: unknown[][] = []
    const em = {
        connection: { options: { type: "postgres" } },
        query: async (sql: string, params: unknown[]) => {
            if (sql.trimStart().startsWith("INSERT")) writes.push(params)
            return []
        },
    } as any
    return { em, writes }
}

afterEach(() => setSystemTime())

describe("genesis seeding time", () => {
    it("seeds identical balance rows on nodes whose clocks differ", async () => {
        const seedAt = async (wallClock: string) => {
            setSystemTime(new Date(wallClock))
            const { em, rows } = memoryRepo()
            await withBlockTime(GENESIS_SEC, () =>
                mergeGenesisBalances(em, [[ALICE, "100"], [BOB, "200"]]),
            )
            return rows
        }
        const first = await seedAt("2026-11-15T00:00:03Z")
        const second = await seedAt("2026-11-15T07:42:19Z")

        expect(second).toEqual(first)
        expect(first.get(ALICE).createdAt.toISOString()).toBe(GENESIS_ISO)
        expect(first.get(ALICE).points.lastUpdated.toISOString()).toBe(GENESIS_ISO)
        expect(first.get(BOB).updatedAt.toISOString()).toBe(GENESIS_ISO)
    })

    it("creates identical burn and treasury rows on nodes whose clocks differ", async () => {
        const seedAt = async (wallClock: string) => {
            setSystemTime(new Date(wallClock))
            const { em, writes } = queryLog()
            await withBlockTime(GENESIS_SEC, () => runGasFeeSeparationMigration(em, 0, TREASURY))
            return writes
        }
        const first = await seedAt("2026-11-15T00:00:03Z")
        const second = await seedAt("2026-11-15T07:42:19Z")

        expect(second).toEqual(first)
        expect(first.length).toBe(3)
        expect(JSON.stringify(first)).toContain(GENESIS_ISO)
    })

    it("runs block 0's seeding under block 0's time", async () => {
        setSystemTime(new Date("2026-11-15T07:42:19Z"))
        await generateGenesisBlock({ balances: [] })
        expect(seededAt?.toISOString()).toBe(GENESIS_ISO)
    })
})
