import { beforeEach, describe, expect, it, mock } from "bun:test"

/**
 * Failure injection at the persistence boundary: a write that fails part-way
 * through a set must leave none of the set on disk, and nothing that follows
 * from it (side effects) may run.
 */

const durable = new Map<string, unknown[]>()
let failOn: string | null = null

function repoFor(staged: Map<string, unknown[]>, entity: { name: string }) {
    return {
        create: (row: unknown) => row,
        save: async (rows: unknown[]) => {
            if (failOn === entity.name) throw new Error(`injected failure writing ${entity.name}`)
            staged.set(entity.name, [...(staged.get(entity.name) ?? []), ...rows])
        },
        delete: async () => {},
        // Bulk insert of assignment rows, as bulkUpdateAssignedTxs issues it
        manager: { connection: { getMetadata: () => ({ columns: [0, 1, 2] }) } },
        createQueryBuilder: () => {
            let chunk: unknown[] = []
            const query = {
                insert: () => query,
                values: (rows: unknown[]) => {
                    chunk = rows
                    return query
                },
                orIgnore: () => query,
                execute: async () => {
                    if (failOn === entity.name) {
                        throw new Error(`injected failure writing ${entity.name}`)
                    }
                    staged.set(entity.name, [...(staged.get(entity.name) ?? []), ...chunk])
                },
            }
            return query
        },
    }
}

const fakeDataSource = {
    // A transaction commits its staged writes only if its callback returns.
    transaction: async (work: (em: unknown) => Promise<void>) => {
        const staged = new Map<string, unknown[]>()
        await work({ getRepository: (entity: { name: string }) => repoFor(staged, entity) })
        for (const [name, rows] of staged) durable.set(name, [...(durable.get(name) ?? []), ...rows])
    },
    getRepository: () => {
        throw new Error("a GCR write escaped the transaction")
    },
}

const datasourceModule = () => ({
    __esModule: true,
    dataSource: fakeDataSource,
    default: { getInstance: async () => ({ getDataSource: () => fakeDataSource }) },
})
mock.module("src/model/datasource", datasourceModule)
mock.module("@/model/datasource", datasourceModule)

const { default: HandleGCR } = await import("@/libs/blockchain/gcr/handleGCR")

function caches(): any {
    return {
        accounts: new Map([["0xaa", { pubkey: "0xaa", balance: 70n, nonce: 1 }]]),
        storagePrograms: new Map(),
        tlsNotaries: new Map(),
        atomicWorks: new Map([["w1", { workId: "w1", winnerAttemptId: "a1", txHash: "0xtx" }]]),
        resourceSlots: new Map([["k1", { state: "settled", generation: 0, workId: "w1", resourceKey: "k1" }]]),
    }
}

beforeEach(() => {
    durable.clear()
    failOn = null
})

describe("saveGCREditChanges at the persistence boundary", () => {
    it("persists a Work's payment, record and slot together", async () => {
        let sideEffectRan = false
        await HandleGCR.saveGCREditChanges(caches(), [async () => { sideEffectRan = true }])

        expect(durable.get("GCRMain")?.length).toBe(1)
        expect(durable.get("GCRAtomicWork")?.length).toBe(1)
        expect(durable.get("GCRResourceSlot")?.length).toBe(1)
        expect(sideEffectRan).toBe(true)
    })

    for (const entity of ["GCRMain", "GCRAtomicWork", "GCRResourceSlot"]) {
        it(`leaves nothing on disk, and runs no side effect, when writing ${entity} fails`, async () => {
            failOn = entity
            let sideEffectRan = false
            await expect(
                HandleGCR.saveGCREditChanges(caches(), [async () => { sideEffectRan = true }]),
            ).rejects.toThrow("injected failure")

            expect(durable.size).toBe(0)
            expect(sideEffectRan).toBe(false)
        })
    }
})

describe("assignments saved with the edits", () => {
    const assignments = () =>
        new Map([["0xaa", [{ txHash: "0xtx", blockNumber: 7 }]]]) as any

    it("persists the assignments in the same transaction as the edits", async () => {
        await HandleGCR.saveGCREditChanges(caches(), [], assignments())

        expect(durable.get("GCRMain")?.length).toBe(1)
        expect(durable.get("GCRAssignedTx")).toEqual([
            { pubkey: "0xaa", txHash: "0xtx", blockNumber: 7 },
        ])
    })

    it("leaves no edits behind when recording the assignments fails", async () => {
        failOn = "GCRAssignedTx"
        let sideEffectRan = false
        await expect(
            HandleGCR.saveGCREditChanges(
                caches(),
                [async () => { sideEffectRan = true }],
                assignments(),
            ),
        ).rejects.toThrow("injected failure")

        expect(durable.size).toBe(0)
        expect(sideEffectRan).toBe(false)
    })
})
