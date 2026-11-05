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
 * An edit that would leave a row Postgres refuses fails its transaction, and
 * the transaction leaves nothing behind; one whose odd text the routine does
 * not store, or stores where Postgres takes it, applies as it always did, so
 * history that committed still replays.
 */

installStorageEditMocks()

const { default: HandleGCR } = await import("./handleGCR")
const { default: Chain } = await import("../chain")
const { getSharedState } = await import("@/utilities/sharedState")
const { unstorableRow, indexedColumns, indexedValues, ROW_ENTITIES } = await import("./storableRows")

/** Text no compression shrinks: a b-tree entry keeps about its length. */
const random = (length: number) =>
    Array.from({ length }, (_, i) => String.fromCharCode(0x21 + ((i * 7919 + 13) % 89))).join("")

const caches = (program: unknown = null) => storageCaches(program)

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
        const entities = await caches(storedProgram())
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

describe("a program stored with an indexed value over the cap", () => {
    // Older nodes stored names up to what the b-tree took, and a snapshot
    // import copies them as they are.
    const longName = random(1100)
    const stored = () => Object.assign(storedProgram(), { programName: longName })

    for (const [operation, variables] of [
        ["SET_FIELD", { field: "n", value: 2 }],
        ["WRITE_STORAGE", { data: { n: 2 } }],
        ["UPDATE_ACCESS_CONTROL", { acl: { mode: "public" } }],
        ["DELETE_STORAGE_PROGRAM", {}],
    ] as const) {
        it(`still takes an edit that leaves the value as it was: ${operation}`, async () => {
            const entities = await caches(stored())
            const result = await HandleGCR.applyTransaction(
                entities,
                tx([burn(1), storage(operation, variables)]),
                false,
                false,
            )
            expect(result.success).toBe(true)
            expect(entities.storagePrograms.get(ADDRESS).programName).toBe(longName)
            expect(entities.accounts.get(SENDER).balance).toBe(START - 1n)
        })
    }

    it("is not a value a new program may take", async () => {
        const entities = await caches()
        const result = await HandleGCR.applyTransaction(
            entities,
            tx([burn(1), create({ programName: longName })]),
            false,
            false,
        )
        expect(result.success).toBe(false)
        expect(result.message).toContain("storagePrograms.programName")
    })
})

describe("the rows an identity edit is judged on", () => {
    const OTHER = "0x" + "cd".repeat(32)
    const pqcAdd = (signature: string) => ({
        type: "identity",
        context: "pqc",
        operation: "add",
        account: SENDER,
        data: [{ algorithm: "falcon", address: "pqc-addr", signature, timestamp: 1 }],
        isRollback: false,
        txhash: "",
    })

    it("are its own account's, not one another group holds mid-apply", async () => {
        const entities = await caches()
        const other = await HandleGCR.createAccount(OTHER, {}, true)
        other.identities.pqc = { falcon: [{ address: "x", signature: "\u0000", timestamp: 1 }] }
        entities.accounts.set(OTHER, other)
        entities.zkCommitments = new Map([["\u0000", true]])

        const result = await HandleGCR.applyStorableEdit(pqcAdd("sig") as never, entities)
        expect(result.success).toBe(true)
    })

    it("refuse what the edit wrote into its own account", async () => {
        const entities = await caches()
        const result = await HandleGCR.applyStorableEdit(pqcAdd("sig\u0000") as never, entities)
        expect(result.success).toBe(false)
        expect(result.message).toContain("accounts.identities")
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
        const row = storedProgram()
        expect(unstorableRow("storagePrograms", row)).toBeNull()
        expect(unstorableRow("storagePrograms", { ...row, owner: "a\ud800" })).toBeNull()
        expect(unstorableRow("storagePrograms", { ...row, owner: "a\u0000" })).toBe("storagePrograms.owner")
        expect(unstorableRow("storagePrograms", { ...row, data: { k: "\ud800" } })).toBe("storagePrograms.data")
        expect(unstorableRow("resourceSlots", { state: "\ud800" })).toBe("resourceSlots")
    })
})

describe("indexed text columns", () => {
    it("refuse a value too long for a b-tree entry, other text does not", () => {
        const row = storedProgram()
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

    it("judge a value the row already held only when the edit changed it", () => {
        const long = random(1100)
        const row = { ...storedProgram(), programName: long }
        const stored = indexedValues("storagePrograms", row)
        expect(stored?.programName).toBe(long)
        expect(unstorableRow("storagePrograms", row, stored)).toBeNull()
        expect(unstorableRow("storagePrograms", { ...row, programName: random(1101) }, stored)).toBe(
            "storagePrograms.programName",
        )
        // U+0000 is refused by Postgres itself, whatever the row held.
        expect(unstorableRow("storagePrograms", { ...row, owner: "a\u0000" }, { ...stored, owner: "a\u0000" })).toBe(
            "storagePrograms.owner",
        )
        expect(unstorableRow("storagePrograms", row)).toBe("storagePrograms.programName")
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
