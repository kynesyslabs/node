import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"

/**
 * A transaction that fails part-way through its edits leaves the state as it
 * found it: the fee it paid is neither kept nor refunded twice, and a storage
 * write it made before the failing edit is gone.
 */

const fakeDataSource = { getRepository: () => ({}) }
const datasourceModule = () => ({
    __esModule: true,
    dataSource: fakeDataSource,
    default: { getInstance: async () => ({ getDataSource: () => fakeDataSource }) },
})
mock.module("src/model/datasource", datasourceModule)
mock.module("@/model/datasource", datasourceModule)
mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: () => {},
        info: () => {},
        warning: () => {},
        error: () => {},
        only: () => {},
    },
}))

const { default: HandleGCR } = await import("./handleGCR")
const { default: Chain } = await import("../chain")
const { GCRStorageProgram } = await import("@/model/entities/GCRv2/GCR_StorageProgram")
const { getSharedState } = await import("@/utilities/sharedState")

const SENDER = "0x" + "ab".repeat(32)
const ADDRESS = "stor-" + "ef".repeat(20)
const START = 100n

function storedProgram() {
    return Object.assign(new GCRStorageProgram(), {
        storageAddress: ADDRESS,
        owner: SENDER,
        programName: "probe",
        encoding: "json",
        data: { n: 1 },
        sizeBytes: 7,
        acl: { mode: "owner" },
        metadata: null,
        storageLocation: "onchain",
        ipfsCid: null,
        salt: null,
        createdByTx: "tx_create",
        lastModifiedByTx: "tx_create",
        interactionTxs: ["tx_create"],
        totalFeesPaid: 1n,
        isDeleted: false,
        deletedByTx: null,
    })
}

async function caches(program: unknown = storedProgram()): Promise<any> {
    return {
        accounts: new Map([
            [SENDER, await HandleGCR.createAccount(SENDER, { balance: START }, true)],
        ]),
        storagePrograms: new Map([[ADDRESS, program]]),
        tlsNotaries: new Map(),
        atomicWorks: new Map(),
        resourceSlots: new Map(),
    }
}

const burn = (amount: number) => ({
    type: "balance",
    operation: "remove",
    account: SENDER,
    amount,
    isRollback: false,
    txhash: "",
})
const storage = (operation: string, variables: Record<string, unknown>) => ({
    type: "storageProgram",
    target: ADDRESS,
    isRollback: false,
    txhash: "",
    context: {
        operation,
        sender: SENDER,
        data: { variables: { operation, storageAddress: ADDRESS, ...variables }, metadata: null },
    },
})

const tx = (edits: unknown[]): any => ({
    hash: "aa".repeat(32),
    content: { type: "storageProgram", from: SENDER, from_ed25519_address: SENDER, gcr_edits: edits },
})

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
})
