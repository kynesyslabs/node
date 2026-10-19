import { describe, expect, it } from "bun:test"

import {
    ATOMIC_STORAGE_DOMAIN,
    deriveStorageAddress,
    storageValueDigest,
} from "@/libs/atomic-work/storageWrite"
import {
    applyAtomicStoragePut,
    type StoragePutEdit,
} from "@/libs/blockchain/gcr/gcr_routines/GCRAtomicStorageRoutines"
import type { GCRStorageProgram } from "@/model/entities/GCRv2/GCR_StorageProgram"

const WRITER = "0x" + "aa".repeat(32)
const target = deriveStorageAddress(ATOMIC_STORAGE_DOMAIN, WRITER, "result", "1")

const put = (over: Partial<StoragePutEdit> = {}): StoragePutEdit => {
    const value = over.value ?? { paid: true, amount: 5 }
    return {
        type: "storage-program-put",
        txhash: "tx1",
        target,
        writer: WRITER,
        name: "result",
        discriminator: "1",
        mode: "create-only",
        value,
        ...over,
        valueDigest: over.valueDigest ?? storageValueDigest(value),
    }
}

describe("applyAtomicStoragePut", () => {
    it("creates a public entry at the derived address", () => {
        const programs = new Map<string, GCRStorageProgram | null>()
        expect(applyAtomicStoragePut(put(), programs, false).success).toBe(true)
        const entry = programs.get(target)!
        expect(entry.data).toEqual({ paid: true, amount: 5 })
        expect(entry.owner).toBe(WRITER)
        expect(entry.acl).toEqual({ mode: "public" })
        expect(entry.lastModifiedByTx).toBe("tx1")
    })

    it("refuses an address the writer did not derive, and a value that does not match its digest", () => {
        const programs = new Map<string, GCRStorageProgram | null>()
        expect(applyAtomicStoragePut(put({ target: "stor-" + "0".repeat(40) }), programs, false).success).toBe(false)
        expect(applyAtomicStoragePut(put({ valueDigest: "f".repeat(64) }), programs, false).success).toBe(false)
        expect(programs.size).toBe(0)
    })

    it("refuses a value that is not canonical JSON", () => {
        const programs = new Map<string, GCRStorageProgram | null>()
        const out = applyAtomicStoragePut(put({ value: { ratio: 0.5 }, valueDigest: "x" }), programs, false)
        expect(out.success).toBe(false)
        expect(out.message).toContain("canonical")
    })

    it("refuses create-only over an existing entry and requires the right prior for compare-and-set", () => {
        const programs = new Map<string, GCRStorageProgram | null>()
        applyAtomicStoragePut(put(), programs, false)
        expect(applyAtomicStoragePut(put({ txhash: "tx2" }), programs, false).success).toBe(false)

        const next = { paid: true, amount: 6 }
        const cas = (expectedPriorDigest: string) =>
            put({ txhash: "tx2", mode: "compare-and-set", value: next, valueDigest: storageValueDigest(next), expectedPriorDigest })
        expect(applyAtomicStoragePut(cas("0".repeat(64)), programs, false).success).toBe(false)
        expect(applyAtomicStoragePut(cas(storageValueDigest({ amount: 5, paid: true })), programs, false).success).toBe(true)
        expect(programs.get(target)!.data).toEqual(next)
    })

    it("matches the prior value whatever order its keys come back in", () => {
        // Postgres jsonb does not keep insertion order.
        expect(storageValueDigest({ b: 1, a: 2 })).toBe(storageValueDigest({ a: 2, b: 1 }))
    })

    it("undoes a replacement back to the replaced value, and a creation to nothing", () => {
        const programs = new Map<string, GCRStorageProgram | null>()
        applyAtomicStoragePut(put(), programs, false)
        const next = { paid: false }
        const cas = put({
            txhash: "tx2",
            mode: "compare-and-set",
            value: next,
            valueDigest: storageValueDigest(next),
            expectedPriorDigest: storageValueDigest({ paid: true, amount: 5 }),
        })
        applyAtomicStoragePut(cas, programs, false)

        expect(applyAtomicStoragePut(put(), programs, true).success).toBe(false)
        expect(applyAtomicStoragePut(cas, programs, true).success).toBe(true)
        expect(programs.get(target)!.data).toEqual({ paid: true, amount: 5 })
        expect(programs.get(target)!.lastModifiedByTx).toBe("tx1")

        expect(applyAtomicStoragePut(put(), programs, true).success).toBe(true)
        expect(programs.get(target)).toBeNull()
    })
})
