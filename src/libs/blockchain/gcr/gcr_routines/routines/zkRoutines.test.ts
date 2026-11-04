import { describe, expect, it, mock } from "bun:test"

/**
 * A commitment's row is inserted in the block's database transaction, so a
 * provider or timestamp Postgres refuses there failed the block on every
 * node. Checked when the edit applies, it fails this transaction alone.
 */

const fakeDataSource = { getRepository: () => ({ findOne: async () => null }) }
const datasourceModule = () => ({
    __esModule: true,
    dataSource: fakeDataSource,
    default: { getInstance: async () => ({ getDataSource: () => fakeDataSource }) },
})
mock.module("src/model/datasource", datasourceModule)
mock.module("@/model/datasource", datasourceModule)
mock.module("@/utilities/logger", () => ({
    __esModule: true,
    default: { debug: () => {}, info: () => {}, warn: () => {}, warning: () => {}, error: () => {}, only: () => {} },
}))

const { applyZkCommitmentAdd } = await import("./zkRoutines")

const edit = (payload: Record<string, unknown>) => ({
    type: "identity",
    operation: "zk_commitmentadd",
    txhash: "aa".repeat(32),
    data: { commitment_hash: "c".repeat(64), provider: "github", timestamp: 1_760_000_000_000, ...payload },
})

const caches = (): any => ({ accounts: new Map(), zkCommitments: new Map() })

describe("applyZkCommitmentAdd", () => {
    it("stages the row of a clean commitment", async () => {
        const result = await applyZkCommitmentAdd(edit({}), false, caches())
        expect(result.success).toBe(true)
        expect(result.deferredWrite).toBeDefined()
    })

    for (const [name, payload] of [
        ["U+0000 in the provider, a text column", { provider: "git\u0000hub" }],
        ["a fractional timestamp, which bigint refuses", { timestamp: 1.5 }],
        ["a timestamp beyond bigint", { timestamp: 1e20 }],
    ] as const) {
        it(`fails the transaction, staging nothing: ${name}`, async () => {
            const entities = caches()
            const result = await applyZkCommitmentAdd(edit(payload), false, entities)
            expect(result.success).toBe(false)
            expect(result.deferredWrite).toBeUndefined()
            expect(entities.zkCommitments.size).toBe(0)
        })
    }
})
