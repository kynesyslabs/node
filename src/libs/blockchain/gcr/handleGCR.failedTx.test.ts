import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"

import {
    ADDRESS,
    SENDER,
    START,
    burn,
    installStorageEditMocks,
    storage,
    storageCaches,
    storedProgram,
    tx,
} from "./storageEdits.fixtures"

/**
 * A transaction that fails part-way through its edits leaves the state as it
 * found it: the fee it paid is neither kept nor refunded twice, and a storage
 * write it made before the failing edit is gone.
 */

installStorageEditMocks()

const { default: HandleGCR } = await import("./handleGCR")
const { default: Chain } = await import("../chain")
const { getSharedState } = await import("@/utilities/sharedState")

const caches = (program: unknown = storedProgram()) => storageCaches(program)

const prod = getSharedState.PROD
beforeEach(() => {
    spyOn(Chain, "getLastBlockNumber").mockResolvedValue(100)
    getSharedState.PROD = true
})
afterEach(() => {
    getSharedState.PROD = prod
})

describe("a transaction that fails part-way", () => {
    it("is not refunded the fee it paid before a storage edit failed", async () => {
        for (const failing of [
            storage("SET_ITEM", { field: "n", index: 0, value: 1 }),
            storage("WRITE_STORAGE", { data: { n: 2 } }),
        ]) {
            const program = storedProgram()
            const entities = await caches(failing.context.operation === "WRITE_STORAGE" ? null : program)
            const result = await HandleGCR.applyTransaction(
                entities,
                tx([burn(10), failing, burn(1)]),
                false,
                false,
            )
            expect(result.success).toBe(false)
            expect(entities.accounts.get(SENDER).balance).toBe(START)
        }
    })

    it("keeps no storage write when a later edit fails", async () => {
        const entities = await caches()
        const result = await HandleGCR.applyTransaction(
            entities,
            tx([burn(1), storage("SET_FIELD", { field: "n", value: 2 }), burn(1000)]),
            false,
            false,
        )
        expect(result.success).toBe(false)
        expect(entities.accounts.get(SENDER).balance).toBe(START)
        const program = entities.storagePrograms.get(ADDRESS)
        expect(program.data).toEqual({ n: 1 })
        expect(program.lastModifiedByTx).toBe("tx_create")
        expect(program.totalFeesPaid).toBe(1n)
    })

    it("keeps no program a failed transaction created", async () => {
        const entities = await caches()
        entities.storagePrograms.delete(ADDRESS)
        const result = await HandleGCR.applyTransaction(
            entities,
            tx([
                burn(1),
                storage("CREATE_STORAGE_PROGRAM", { programName: "p", data: { a: 1 } }),
                burn(1000),
            ]),
            false,
            false,
        )
        expect(result.success).toBe(false)
        expect(entities.storagePrograms.has(ADDRESS)).toBe(false)
    })

    it("keeps no TLSNotary proof when a later edit fails", async () => {
        const entities = await caches()
        const store = {
            type: "tlsnotary",
            operation: "store",
            account: SENDER,
            isRollback: false,
            txhash: "",
            data: {
                tokenId: "token-1",
                domain: "example.com",
                proof: "proof",
                storageType: "onchain",
                timestamp: 1,
            },
        }
        const result = await HandleGCR.applyTransaction(
            entities,
            tx([burn(1), store, burn(1000)]),
            false,
            false,
        )
        expect(result.success).toBe(false)
        expect(entities.tlsNotaries.has("token-1")).toBe(false)
        expect(entities.accounts.get(SENDER).balance).toBe(START)
    })

    it("keeps a proof row that was there before the failed transaction", async () => {
        const entities = await caches()
        const before = { tokenId: "token-2", owner: SENDER, domain: "a.example", proof: "p" }
        entities.tlsNotaries.set("token-2", before)
        const store = {
            type: "tlsnotary",
            operation: "store",
            account: SENDER,
            isRollback: false,
            txhash: "",
            data: { tokenId: "token-2", domain: "b.example", proof: "q", storageType: "onchain", timestamp: 1 },
        }
        const result = await HandleGCR.applyTransaction(entities, tx([burn(1), store]), false, false)
        expect(result.success).toBe(false)
        expect(entities.tlsNotaries.get("token-2")).toEqual(before)
    })

    it("applies all of a transaction that succeeds", async () => {
        const entities = await caches()
        const result = await HandleGCR.applyTransaction(
            entities,
            tx([burn(1), storage("SET_FIELD", { field: "n", value: 2 }), burn(1)]),
            false,
            false,
        )
        expect(result.success).toBe(true)
        expect(entities.accounts.get(SENDER).balance).toBe(START - 2n)
        expect(entities.storagePrograms.get(ADDRESS).data).toEqual({ n: 2 })
    })

    // A failing storage edit replays the earlier edits as undos first; a
    // granular write cannot be undone from its edit, so it must not be
    // applied a second time or touch another item on the way.
    for (const [operation, variables] of [
        ["SET_FIELD", { field: "n", value: 2 }],
        ["SET_ITEM", { field: "list", index: 0, value: "b" }],
        ["APPEND_ITEM", { field: "list", value: "b" }],
        ["DELETE_FIELD", { field: "n" }],
        ["DELETE_ITEM", { field: "list", index: 0 }],
    ] as const) {
        it(`keeps no ${operation} when a later storage edit fails`, async () => {
            const program = storedProgram()
            program.data = { n: 1, list: ["a", "z"] }
            const entities = await caches(program)
            const before = structuredClone({ ...entities.storagePrograms.get(ADDRESS) })

            const result = await HandleGCR.applyTransaction(
                entities,
                tx([
                    burn(1),
                    storage(operation, variables),
                    storage("SET_ITEM", { field: "n", index: 0, value: 1 }),
                ]),
                false,
                false,
            )

            expect(result.success).toBe(false)
            expect({ ...entities.storagePrograms.get(ADDRESS) }).toEqual(before)
            expect(entities.accounts.get(SENDER).balance).toBe(START)
        })
    }
})

// The stored body must still hash to tx.hash: an apply that writes into the
// signed edits (a stamped txhash, a routine keeping a reference and changing
// it) makes every node that syncs the block reject it.
describe("the signed content", () => {
    const cases: Array<[string, () => unknown, () => Promise<any>]> = [
        ["a storage create", () => storage("CREATE_STORAGE_PROGRAM", { programName: "p", data: { a: { b: 1 } } }), () => caches(null)],
        ["a granular SET_FIELD", () => storage("SET_FIELD", { field: "n", value: { deep: [1] } }), () => caches()],
    ]
    for (const [name, edit, setup] of cases) {
        for (const [outcome, trailing] of [
            ["applies", [] as unknown[]],
            ["fails part-way", [burn(1000)]],
        ] as const) {
            it(`is left as signed when ${name} ${outcome}`, async () => {
                const signed = tx([burn(1), edit(), ...trailing])
                const before = structuredClone(signed.content)
                const result = await HandleGCR.applyTransaction(await setup(), signed, false, false)
                expect(result.success).toBe(outcome === "applies")
                expect(signed.content).toEqual(before)
            })
        }
    }
})
