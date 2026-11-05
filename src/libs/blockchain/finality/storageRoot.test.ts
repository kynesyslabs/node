import { beforeEach, describe, expect, it, spyOn } from "bun:test"
import log from "src/utilities/logger"
import { toHex } from "@/libs/crypto/merkle/hex"
import { EMPTY_SUBTREE, SparseMerkleTree } from "@/libs/crypto/merkle/sparse"
import { storageProgramKey, storageProgramLeafHex, type StorageProgramRow } from "./storageRecord"
import {
    StorageProgramsRoot,
    type StorageRootReader,
    type StorageRootSnapshot,
    type StoredLeaf,
} from "./storageRoot"

const errors: string[] = []
spyOn(log, "error").mockImplementation(((message: string) => {
    errors.push(message)
}) as never)

interface StoredRow extends StorageProgramRow {
    smtLeaf: string | null
    version: number
}

/** The table, as the database would hold it, with Postgres-like row versions. */
class FakeTable implements StorageRootReader {
    rows = new Map<string, StoredRow>()
    private nextVersion = 1
    reads = 0
    rowReads = 0
    fills: StoredLeaf[][] = []
    failFill = false
    /** Runs between the leaf read and the row read, inside the snapshot. */
    duringRead: (() => void) | null = null

    /** A write through the write path: the leaf comes with the row. */
    write(program: StorageProgramRow): void {
        this.rows.set(program.storageAddress, {
            ...program,
            smtLeaf: storageProgramLeafHex(program),
            version: this.nextVersion++,
        })
    }

    /** A row inserted without its leaf, as a genesis restore does. */
    insertBare(program: StorageProgramRow): void {
        this.rows.set(program.storageAddress, { ...program, smtLeaf: null, version: this.nextVersion++ })
    }

    delete(storageAddress: string): void {
        this.rows.delete(storageAddress)
    }

    async read<T>(work: (snapshot: StorageRootSnapshot) => Promise<T>): Promise<T> {
        this.reads++
        const view = new Map([...this.rows].map(([k, v]) => [k, structuredClone(v)]))
        return await work({
            leaves: async () => {
                const out = [...view.values()]
                    .sort((a, b) => (a.storageAddress < b.storageAddress ? -1 : 1))
                    .map(r => ({ storageAddress: r.storageAddress, smtLeaf: r.smtLeaf, version: String(r.version) }))
                this.duringRead?.()
                return out
            },
            rows: async (addresses: string[]) => {
                this.rowReads += addresses.length
                return addresses.flatMap(a => view.get(a) ?? [])
            },
        })
    }

    async fillLeaves(leaves: StoredLeaf[]): Promise<void> {
        if (this.failFill) throw new Error("injected fill failure")
        this.fills.push(leaves)
        for (const leaf of leaves) {
            const stored = this.rows.get(leaf.storageAddress)
            if (stored && String(stored.version) === leaf.version) stored.smtLeaf = leaf.smtLeaf
        }
    }
}

function program(i: number, overrides: Partial<StorageProgramRow> = {}): StorageProgramRow {
    return {
        storageAddress: `stor-${i.toString(16).padStart(40, "0")}`,
        owner: `0x${(i % 7).toString(16)}`,
        programName: `p${i}`,
        encoding: i % 3 === 0 ? "binary" : "json",
        data: i % 3 === 0 ? Buffer.from(`bytes-${i}`).toString("base64") : { i, f: i / 3, s: `v${i}` },
        sizeBytes: 10 + i,
        acl: { mode: i % 2 ? "public" : "owner" },
        metadata: i % 5 ? null : { note: `n${i}` },
        createdByTx: `0xc${i}`,
        lastModifiedByTx: `0xm${i}`,
        isDeleted: i % 11 === 0,
        ...overrides,
    }
}

/** The root as the definition gives it, from the rows alone. */
function expectedRoot(rows: StorageProgramRow[]): string {
    return SparseMerkleTree.build(
        rows.map(r => ({ key: storageProgramKey(r.storageAddress), valueHash: storageProgramLeafHex(r) })),
    ).rootHex
}

let table: FakeTable

function storedRow(storageAddress: string): StoredRow {
    const stored = table.rows.get(storageAddress)
    if (!stored) throw new Error(`no row ${storageAddress}`)
    return stored
}

let root: StorageProgramsRoot

beforeEach(() => {
    errors.length = 0
    table = new FakeTable()
    root = new StorageProgramsRoot(table)
})

describe("storage state root", () => {
    it("is the empty subtree for an empty table", async () => {
        expect(await root.root()).toBe(toHex(EMPTY_SUBTREE))
    })

    it("equals the sparse tree built over every row's key and leaf", async () => {
        const rows = Array.from({ length: 50 }, (_, i) => program(i))
        for (const r of rows) table.write(r)
        expect(await root.root()).toBe(expectedRoot(rows))
        expect(table.rowReads).toBe(0)
    })

    it("computes and stores the leaves of rows written without one, giving the same root", async () => {
        const rows = Array.from({ length: 20 }, (_, i) => program(i))
        rows.forEach((r, i) => (i % 2 ? table.write(r) : table.insertBare(r)))

        expect(await root.root()).toBe(expectedRoot(rows))
        expect(table.rowReads).toBe(10)
        expect(table.fills.flat().map(f => f.storageAddress).sort()).toEqual(
            rows.filter((_, i) => i % 2 === 0).map(r => r.storageAddress).sort(),
        )
        for (const r of rows) {
            expect(storedRow(r.storageAddress).smtLeaf).toBe(storageProgramLeafHex(r))
        }

        root.markDirty()
        table.rowReads = 0
        expect(await root.root()).toBe(expectedRoot(rows))
        expect(table.rowReads).toBe(0)
    })

    it("recomputes a malformed stored leaf from its row", async () => {
        const rows = [program(1), program(2)]
        rows.forEach(r => table.write(r))
        storedRow(rows[0].storageAddress).smtLeaf = "not-a-leaf"
        expect(await root.root()).toBe(expectedRoot(rows))
    })

    it("never stores a computed leaf on a row changed since it was read", async () => {
        const first = program(1)
        table.insertBare(first)
        table.duringRead = () => {
            // Committed between the leaf read and the fill, without a leaf.
            table.insertBare(program(1, { owner: "0xnew" }))
        }
        await root.root()
        expect(storedRow(first.storageAddress).smtLeaf).toBeNull()
    })

    it("still answers when storing computed leaves fails", async () => {
        table.insertBare(program(1))
        table.failFill = true
        expect(await root.root()).toBe(expectedRoot([program(1)]))
    })

    it("is not rebuilt until a write marks it dirty", async () => {
        const rows = Array.from({ length: 10 }, (_, i) => program(i))
        rows.forEach(r => table.write(r))
        const first = await root.root()
        await root.root()
        await root.root()
        expect(root.builds).toBe(1)
        expect(table.reads).toBe(1)

        const changed = program(3, { data: { changed: true }, lastModifiedByTx: "0xm3b" })
        table.write(changed)
        // Without the mark the cached root is served.
        expect(await root.root()).toBe(first)
        root.markDirty()
        const after = await root.root()
        expect(after).not.toBe(first)
        expect(after).toBe(expectedRoot(rows.map(r => (r.storageAddress === changed.storageAddress ? changed : r))))
        expect(root.builds).toBe(2)
    })

    it("does not serve a root read while a write was in flight once that write marks it", async () => {
        table.write(program(1))
        table.duringRead = () => {
            table.write(program(2))
            root.markDirty()
        }
        const during = await root.root()
        table.duringRead = null
        expect(during).toBe(expectedRoot([program(1)]))
        expect(await root.root()).toBe(expectedRoot([program(1), program(2)]))
    })

    it("drops a deleted row and returns to the earlier root", async () => {
        table.write(program(1))
        const one = await root.root()
        table.write(program(2))
        root.markDirty()
        expect(await root.root()).not.toBe(one)
        table.delete(program(2).storageAddress)
        root.markDirty()
        expect(await root.root()).toBe(one)
    })

    describe("debug recompute", () => {
        it("rebuilds from the rows on every read and reports a stale stored leaf", async () => {
            const recompute = new StorageProgramsRoot(table, () => true)
            const rows = [program(1), program(2), program(3)]
            rows.forEach(r => table.write(r))
            storedRow(rows[1].storageAddress).smtLeaf = storageProgramLeafHex(program(99))

            expect(await recompute.root()).toBe(expectedRoot(rows))
            expect(errors.join("\n")).toContain(rows[1].storageAddress)
            await recompute.root()
            expect(recompute.builds).toBe(2)
        })

        it("reports a cached root that a write forgot to mark dirty", async () => {
            let enabled = false
            const checked = new StorageProgramsRoot(table, () => enabled)
            table.write(program(1))
            await checked.root()
            table.write(program(2))
            enabled = true
            expect(await checked.root()).toBe(expectedRoot([program(1), program(2)]))
            expect(errors.join("\n")).toContain("stale")
        })

        it("stays quiet when leaves and cache agree with the rows", async () => {
            const recompute = new StorageProgramsRoot(table, () => true)
            Array.from({ length: 5 }, (_, i) => program(i)).forEach(r => table.write(r))
            await recompute.root()
            await recompute.root()
            expect(errors).toEqual([])
        })
    })

    it("prints the rebuild cost for 10^4 programs", async () => {
        const rows = Array.from({ length: 10_000 }, (_, i) => program(i))
        rows.forEach(r => table.write(r))
        const start = performance.now()
        const value = await root.root()
        const cold = performance.now() - start
        const cachedStart = performance.now()
        await root.root()
        const cached = performance.now() - cachedStart
        // eslint-disable-next-line no-console
        console.log(`[perf] storage root over 10^4 programs: rebuild ${cold.toFixed(1)} ms, cached ${cached.toFixed(3)} ms`)
        expect(value).toMatch(/^[0-9a-f]{64}$/)
    })
})
