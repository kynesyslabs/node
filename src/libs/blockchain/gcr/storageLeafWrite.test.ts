import { beforeEach, describe, expect, it, mock } from "bun:test"
import {
    ATOMIC_STORAGE_DOMAIN,
    deriveStorageAddress,
    storageValueDigest,
} from "@/libs/atomic-work/storageWrite"
import { storageProgramLeafHex } from "@/libs/blockchain/finality/storageRecord"
import { applyAtomicStoragePut } from "@/libs/blockchain/gcr/gcr_routines/GCRAtomicStorageRoutines"
import { GCRStorageProgram } from "@/model/entities/GCRv2/GCR_StorageProgram"

/**
 * The storage root reads each program's leaf from the row, so every write
 * must store the leaf of exactly the row it writes, in the same transaction,
 * and mark the cached root dirty.
 */

const saved: any[] = []
const deleted: unknown[] = []

const repoFor = (entity: { name: string }) => ({
    create: (row: unknown) => row,
    save: async (rows: any[]) => {
        // What the database keeps is a copy at the time of the write.
        if (entity.name === "GCRStorageProgram") saved.push(...rows.map(r => ({ ...r })))
    },
    delete: async (where: unknown) => {
        if (entity.name === "GCRStorageProgram") deleted.push(where)
    },
})

const fakeDataSource = {
    transaction: async (work: (em: unknown) => Promise<void>) => {
        await work({ getRepository: repoFor })
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

let marks = 0
mock.module("@/libs/blockchain/finality/storageRoot", () => ({
    __esModule: true,
    markStorageProgramsDirty: () => {
        marks++
    },
    storageProgramsRoot: async () => "0".repeat(64),
    proveStoragePrograms: async () => ({ root: "0".repeat(64), proofs: [] }),
}))

// Imported once the database is mocked: handleGCR reads it at load.
const handleGCR = (await import("@/libs/blockchain/gcr/handleGCR")).default

function caches(programs: Map<string, any> = new Map()): any {
    return {
        accounts: new Map(),
        storagePrograms: programs,
        tlsNotaries: new Map(),
        atomicWorks: new Map(),
        resourceSlots: new Map(),
    }
}

function program(overrides: Record<string, unknown> = {}): GCRStorageProgram {
    return Object.assign(new GCRStorageProgram(), {
        storageAddress: "stor-" + "1".repeat(40),
        owner: "0xaa",
        programName: "notes",
        encoding: "json",
        data: { a: 1 },
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

/** A row as `find` returns it: database timestamps, a bigint fee, maybe a leaf. */
const loaded = (overrides: Record<string, unknown> = {}) =>
    program({ createdAt: new Date(), updatedAt: new Date(), ...overrides })

beforeEach(() => {
    saved.length = 0
    deleted.length = 0
    marks = 0
})

describe("storage program writes", () => {
    it("store each row with the leaf of what is written", async () => {
        const a = program()
        const b = program({ storageAddress: "stor-" + "2".repeat(40), data: "AAEC", encoding: "binary" })
        await handleGCR.saveGCREditChanges(
            caches(new Map([[a.storageAddress, a], [b.storageAddress, b]])),
            [],
        )
        expect(saved.map(r => r.smtLeaf)).toEqual([storageProgramLeafHex(a), storageProgramLeafHex(b)])
    })

    it("replace a stale leaf the row was loaded with", async () => {
        const stale = loaded({ smtLeaf: "f".repeat(64), data: { a: 2 } })
        await handleGCR.saveGCREditChanges(caches(new Map([[stale.storageAddress, stale]])), [])
        expect(saved[0].smtLeaf).toBe(storageProgramLeafHex(program({ data: { a: 2 } })))
        expect(saved[0].smtLeaf).not.toBe("f".repeat(64))
    })

    it("mark the root dirty when the write is issued and again after it commits", async () => {
        const a = program()
        await handleGCR.saveGCREditChanges(caches(new Map([[a.storageAddress, a]])), [])
        expect(marks).toBe(2)

        marks = 0
        await handleGCR.saveGCREditChanges(caches(new Map([[a.storageAddress, null]])), [])
        expect(deleted.length).toBe(1)
        expect(marks).toBe(2)
    })

    it("leave the root alone when no storage program is written", async () => {
        await handleGCR.saveGCREditChanges(caches(), [])
        expect(marks).toBe(0)
    })

    it("do the same for a write held until its block commits", async () => {
        const a = program()
        const pending = handleGCR.pendingWrite(caches(new Map([[a.storageAddress, a]])), new Map(), [], [])
        await pending.write({ getRepository: repoFor } as any)
        expect(saved[0].smtLeaf).toBe(storageProgramLeafHex(a))
        expect(marks).toBe(1)
        await pending.afterCommit()
        expect(marks).toBe(2)
    })

    it("still issue a write whose leaf cannot be computed, with no leaf", async () => {
        const odd = program({ sizeBytes: Number.NaN })
        await handleGCR.saveGCREditChanges(caches(new Map([[odd.storageAddress, odd]])), [])
        expect(saved[0].smtLeaf).toBeNull()
    })
})

describe("Work storage writes and their rollback", () => {
    const WRITER = "0x" + "aa".repeat(32)
    const target = deriveStorageAddress(ATOMIC_STORAGE_DOMAIN, WRITER, "result", "1")
    const put = (txhash: string, value: unknown, mode: "create-only" | "compare-and-set", prior?: string) => ({
        type: "storage-program-put" as const,
        txhash,
        target,
        writer: WRITER,
        name: "result",
        discriminator: "1",
        mode,
        value,
        valueDigest: storageValueDigest(value),
        expectedPriorDigest: prior,
    })

    /** The entry after one Work created it and its block committed. */
    function created() {
        const programs = new Map<string, any>()
        expect(applyAtomicStoragePut(put("tx1", { v: 1 }, "create-only"), programs, false).success).toBe(true)
        // Read back as the next block loads it.
        const row = JSON.parse(JSON.stringify({ ...programs.get(target), totalFeesPaid: "0" }))
        return { programs, row }
    }

    function replacedOn(nodeLocal: Record<string, unknown>) {
        const { row } = created()
        const programs = new Map<string, any>([
            [target, loaded({ ...row, totalFeesPaid: 0n, ...nodeLocal })],
        ])
        const edit = put("tx2", { v: 2 }, "compare-and-set", storageValueDigest({ v: 1 }))
        expect(applyAtomicStoragePut(edit, programs, false).success).toBe(true)
        return { programs, before: row, edit }
    }

    it("give a replaced entry the same leaf on every node, whatever its database stamped locally", () => {
        const first = replacedOn({ createdAt: new Date(1), updatedAt: new Date(2), smtLeaf: null })
        const second = replacedOn({ createdAt: new Date(3), updatedAt: new Date(4), smtLeaf: "e".repeat(64) })
        const leaf = (p: Map<string, any>) => storageProgramLeafHex(p.get(target))
        expect(leaf(first.programs)).toBe(leaf(second.programs))
        // The rollback snapshot must also survive the jsonb column.
        expect(() => JSON.stringify(first.programs.get(target).metadata)).not.toThrow()
    })

    it("put back the leaf of the replaced entry when the replacing block is rolled back", async () => {
        const { programs, before, edit } = replacedOn({ smtLeaf: null })
        // The rollback runs in a later apply, on the row read back from jsonb.
        const stored = JSON.parse(
            JSON.stringify(programs.get(target), (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
        )
        const reloaded = new Map<string, any>([[target, loaded({ ...stored, totalFeesPaid: 0n })]])
        expect(applyAtomicStoragePut({ ...edit, isRollback: true }, reloaded, true).success).toBe(true)
        const restored = reloaded.get(target)
        expect(typeof restored.totalFeesPaid).toBe("bigint")

        await handleGCR.saveGCREditChanges(caches(reloaded), [])
        expect(saved[0].smtLeaf).toBe(storageProgramLeafHex(before))
        expect(saved[0].lastModifiedByTx).toBe("tx1")
    })

    it("remove a created entry, and so its leaf, when its block is rolled back", async () => {
        const { row } = created()
        const reloaded = new Map<string, any>([[target, loaded({ ...row, totalFeesPaid: 0n })]])
        const undo = { ...put("tx1", { v: 1 }, "create-only"), isRollback: true }
        expect(applyAtomicStoragePut(undo, reloaded, true).success).toBe(true)
        expect(reloaded.get(target)).toBeNull()
        await handleGCR.saveGCREditChanges(caches(reloaded), [])
        expect(deleted.length).toBe(1)
        expect(saved.length).toBe(0)
    })
})
