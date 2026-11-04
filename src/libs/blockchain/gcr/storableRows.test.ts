import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"

/**
 * An edit that would leave a row Postgres refuses fails its transaction, and
 * the transaction leaves nothing behind; one whose odd text the routine does
 * not store, or stores where Postgres takes it, applies as it always did, so
 * history that committed still replays.
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
    default: { debug: () => {}, info: () => {}, warning: () => {}, error: () => {}, only: () => {} },
}))

const { default: HandleGCR } = await import("./handleGCR")
const { default: Chain } = await import("../chain")
const { GCRStorageProgram } = await import("@/model/entities/GCRv2/GCR_StorageProgram")
const { getSharedState } = await import("@/utilities/sharedState")
const { unstorableRow, indexedColumns, ROW_ENTITIES } = await import("./storableRows")

/** Text no compression shrinks: a b-tree entry keeps about its length. */
const random = (length: number) =>
    Array.from({ length }, (_, i) => String.fromCharCode(0x21 + ((i * 7919 + 13) % 89))).join("")

const SENDER = "0x" + "ab".repeat(32)
const ADDRESS = "stor-" + "ef".repeat(20)
const START = 100n

const stored = () =>
    Object.assign(new GCRStorageProgram(), {
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

async function caches(program: unknown = null): Promise<any> {
    return {
        accounts: new Map([[SENDER, await HandleGCR.createAccount(SENDER, { balance: START }, true)]]),
        storagePrograms: new Map(program ? [[ADDRESS, program]] : []),
        tlsNotaries: new Map(),
        atomicWorks: new Map(),
        resourceSlots: new Map(),
    }
}

const burn = (amount: number, account = SENDER) => ({
    type: "balance",
    operation: "remove",
    account,
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

const create = (variables: Record<string, unknown>) =>
    storage("CREATE_STORAGE_PROGRAM", { programName: "p", data: { a: 1 }, ...variables })

describe("a storage program row Postgres would refuse", () => {
    for (const [name, variables] of [
        ["U+0000 in the data", { data: { a: "x\u0000" } }],
        ["an unpaired surrogate in the data", { data: { a: "\ud800" } }],
        ["an unpaired surrogate as a data key", { data: { ["\ud800"]: 1 } }],
        ["an unpaired surrogate in the acl", { acl: { mode: "restricted", allowed: ["\ud800"] } }],
        ["an unpaired surrogate in the metadata", { metadata: { title: "\ud800" } }],
        ["U+0000 in the program name, a text column", { programName: "p\u0000" }],
        ["a program name too long for its index entry", { programName: random(3000) }],
    ] as const) {
        it(`fails the create, leaving no row and the fee unpaid: ${name}`, async () => {
            const entities = await caches()
            const result = await HandleGCR.applyTransaction(entities, tx([burn(1), create(variables)]), false, false)
            expect(result.success).toBe(false)
            expect(result.message).toContain("storagePrograms.")
            expect(entities.storagePrograms.has(ADDRESS)).toBe(false)
            expect(entities.accounts.get(SENDER).balance).toBe(START)
        })
    }

    it("fails a granular write of an unpaired surrogate and keeps the row as it was", async () => {
        const entities = await caches(stored())
        const result = await HandleGCR.applyTransaction(
            entities,
            tx([burn(1), storage("SET_FIELD", { field: "n", value: "\ud800" })]),
            false,
            false,
        )
        expect(result.success).toBe(false)
        expect(entities.storagePrograms.get(ADDRESS).data).toEqual({ n: 1 })
        expect(entities.accounts.get(SENDER).balance).toBe(START)
    })
})

describe("text a routine does not store", () => {
    it("applies a create whose U+0000 sits in a variable the row does not keep", async () => {
        const entities = await caches()
        const result = await HandleGCR.applyTransaction(entities, tx([burn(1), create({ note: "\u0000" })]), false, false)
        expect(result.success).toBe(true)
        expect(entities.storagePrograms.get(ADDRESS).data).toEqual({ a: 1 })
    })
})

describe("unstorableRow", () => {
    it("judges each column by its type", () => {
        const row = stored()
        expect(unstorableRow("storagePrograms", row)).toBeNull()
        expect(unstorableRow("storagePrograms", { ...row, owner: "a\ud800" })).toBeNull()
        expect(unstorableRow("storagePrograms", { ...row, owner: "a\u0000" })).toBe("storagePrograms.owner")
        expect(unstorableRow("storagePrograms", { ...row, data: { k: "\ud800" } })).toBe("storagePrograms.data")
        expect(unstorableRow("resourceSlots", { state: "\ud800" })).toBe("resourceSlots")
    })
})

describe("indexed text columns", () => {
    it("refuse a value too long for a b-tree entry, other text does not", () => {
        const row = stored()
        expect(unstorableRow("storagePrograms", { ...row, programName: random(1024) })).toBeNull()
        expect(unstorableRow("storagePrograms", { ...row, programName: random(1025) })).toBe(
            "storagePrograms.programName",
        )
        // Three bytes each in UTF-8.
        expect(unstorableRow("storagePrograms", { ...row, owner: "€".repeat(342) })).toBe("storagePrograms.owner")
        expect(unstorableRow("storagePrograms", { ...row, ipfsCid: random(5000) })).toBeNull()
        // Any sender may propose; the id is unique and indexed.
        expect(unstorableRow("networkUpgrades", { proposalId: random(3000) })).toBe("networkUpgrades.proposalId")
        expect(unstorableRow("tlsNotaries", { tokenId: "tlsn_x", domain: random(3000) })).toBe("tlsNotaries.domain")
    })

    it("are the ones the schema indexes", () => {
        const indexed = Object.fromEntries(
            Object.entries(ROW_ENTITIES)
                .filter(([, entity]) => entity !== "jsonb")
                .map(([cache, entity]) => [cache, [...indexedColumns(entity as Function)].sort()]),
        )
        // From the migrations: primary keys, unique constraints and indexes.
        expect(indexed).toEqual({
            accounts: ["pubkey"],
            storagePrograms: ["encoding", "owner", "programName", "storageAddress", "storageLocation"],
            tlsNotaries: ["domain", "owner", "tokenId", "txhash"],
            atomicWorks: ["txHash", "workId"],
            validators: ["address", "unstake_available_at", "unstake_requested_at"],
            networkUpgrades: ["effectiveAtBlock", "id", "proposalId", "status"],
            networkUpgradeVotes: ["id", "proposalId", "voterAddress"],
        })
    })
})
