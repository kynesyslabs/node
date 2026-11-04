import { beforeEach, describe, expect, it, spyOn } from "bun:test"
import log from "src/utilities/logger"
import { toHex } from "@/libs/crypto/merkle/hex"
import {
    EMPTY_SUBTREE,
    SparseMerkleTree,
    verifyMembership,
    verifyNonMembership,
} from "@/libs/crypto/merkle/sparse"
import {
    storageProgramKey,
    storageProgramLeafHex,
    storageProgramRecord,
    storageRecordLeafHex,
    type StorageProgramRow,
} from "./storageRecord"
import type { StorageHistoryRow } from "./storageHistory"
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
    /** The undo log, as storageHistory.ts writes it. */
    history: StorageHistoryRow[] = []
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
            history: async (from: number, to: number) =>
                structuredClone(
                    this.history
                        .filter(h => h.block >= from && h.block <= to)
                        .sort((a, b) => b.block - a.block),
                ),
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

describe("storage proofs", () => {
    it("proves present programs by their record and absent ones by the path", async () => {
        const rows = Array.from({ length: 40 }, (_, i) => program(i))
        rows.forEach(r => table.write(r))
        const present = rows[7].storageAddress
        const deleted = rows[11].storageAddress
        const absent = "stor-never-created"

        const { root: provedRoot, proofs } = await root.prove([present, absent, deleted])
        expect(provedRoot).toBe(expectedRoot(rows))
        expect(provedRoot).toBe(await root.root())
        expect(proofs.map(p => p.storageAddress)).toEqual([present, absent, deleted])

        const [p, a, d] = proofs
        expect(p.record).toEqual(storageProgramRecord(rows[7]))
        expect(storageRecordLeafHex(p.record!)).toBe(storageProgramLeafHex(rows[7]))
        expect(
            verifyMembership(storageProgramKey(present), storageRecordLeafHex(p.record!), p, provedRoot),
        ).toBe(true)

        expect(a.record).toBeNull()
        expect(verifyNonMembership(storageProgramKey(absent), a, provedRoot)).toBe(true)

        expect(d.record?.isDeleted).toBe(true)
        expect(verifyMembership(storageProgramKey(deleted), storageRecordLeafHex(d.record!), d, provedRoot)).toBe(true)
    })

    it("serves the data hash of a restricted program, never its data", async () => {
        table.write(program(1, { acl: { mode: "restricted", allowed: ["0xabc"] }, data: { secret: "s3cret" } }))
        const [entry] = (await root.prove([program(1).storageAddress])).proofs
        expect(JSON.stringify(entry)).not.toContain("s3cret")
        expect(entry.record?.dataHash).toMatch(/^[0-9a-f]{64}$/)
    })

    it("proves against rows whose leaf was never stored", async () => {
        table.insertBare(program(3))
        table.write(program(4))
        const { root: provedRoot, proofs } = await root.prove([program(3).storageAddress])
        expect(provedRoot).toBe(expectedRoot([program(3), program(4)]))
        expect(verifyMembership(storageProgramKey(program(3).storageAddress), storageRecordLeafHex(proofs[0].record!), proofs[0], provedRoot)).toBe(true)
    })

    it("proves absence in an empty table against the empty root", async () => {
        const { root: provedRoot, proofs } = await root.prove(["stor-x"])
        expect(provedRoot).toBe(toHex(EMPTY_SUBTREE))
        expect(proofs[0]).toEqual({ storageAddress: "stor-x", record: null, siblings: [], terminal: { kind: "empty" } })
    })

    it("refuses to serve a stored leaf that no longer matches its row", async () => {
        table.write(program(5))
        storedRow(program(5).storageAddress).sizeBytes = 9999
        await expect(root.prove([program(5).storageAddress])).rejects.toThrow(/does not match its row/)
    })
})

describe("storage proofs at a past block", () => {
    /** Applies one block's writes as the write path does: the undo row first, then the row. */
    function applyBlock(block: number, writes: [string, StorageProgramRow | null][]) {
        for (const [address, next] of writes) {
            if (!table.history.some(h => h.block === block && h.storageAddress === address)) {
                const before = table.rows.get(address)
                table.history.push({ block, storageAddress: address, record: before ? storageProgramRecord(before) : null })
            }
            if (next === null) table.delete(address)
            else table.write(next)
        }
    }
    const state = () => [...table.rows.values()]

    it("rebuilds the root of the state before each undone block, and serves that state's records", async () => {
        const a = program(1)
        const b = program(2)
        const after: StorageProgramRow[][] = [state()]
        applyBlock(1, [[a.storageAddress, a], [b.storageAddress, b]])
        after.push(state())
        applyBlock(2, [[a.storageAddress, program(1, { data: { v: 2 } })]])
        after.push(state())
        applyBlock(3, [[b.storageAddress, null], [a.storageAddress, program(1, { isDeleted: true })]])
        after.push(state())

        for (let block = 1; block <= 3; block++) {
            const { root: provedRoot, proofs } = await root.prove([a.storageAddress, b.storageAddress], { fromBlock: block, toBlock: 3 })
            expect(provedRoot).toBe(expectedRoot(after[block - 1]))
            for (const proof of proofs) {
                const before = after[block - 1].find(r => r.storageAddress === proof.storageAddress)
                expect(proof.record).toEqual(before ? storageProgramRecord(before) : null)
                const key = storageProgramKey(proof.storageAddress)
                const holds = proof.record
                    ? verifyMembership(key, storageRecordLeafHex(proof.record), proof, provedRoot)
                    : verifyNonMembership(key, proof, provedRoot)
                expect(holds).toBe(true)
            }
        }
        expect((await root.prove([a.storageAddress])).root).toBe(expectedRoot(after[3]))
    })

    it("keeps the record from before the oldest undone block when several blocks touched a program", async () => {
        const a = program(4)
        applyBlock(5, [[a.storageAddress, a]])
        applyBlock(6, [[a.storageAddress, program(4, { data: "x" })]])
        applyBlock(7, [[a.storageAddress, program(4, { data: "y" })]])
        const { proofs } = await root.prove([a.storageAddress], { fromBlock: 6, toBlock: 7 })
        expect(proofs[0].record).toEqual(storageProgramRecord(a))
        expect((await root.prove([a.storageAddress], { fromBlock: 5, toBlock: 7 })).proofs[0].record).toBeNull()
    })

    it("leaves programs no undone block touched at their live rows", async () => {
        const untouched = program(8)
        table.write(untouched)
        applyBlock(9, [[program(9).storageAddress, program(9)]])
        const { proofs } = await root.prove([untouched.storageAddress], { fromBlock: 9, toBlock: 9 })
        expect(proofs[0].record).toEqual(storageProgramRecord(untouched))
        expect(table.rowReads).toBe(1)
    })
})
