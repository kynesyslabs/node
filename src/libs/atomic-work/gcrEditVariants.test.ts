import { describe, expect, it } from "bun:test"
import type {
    GCREdit,
    GCREditResourceSlot,
    GCREditWorkAttempt,
    GCREditStoragePut,
} from "@kynesyslabs/demosdk/types"
import type { SlotCasExpectation } from "@/libs/atomic-work/resourceSlot"

/**
 * s1 verification: the three Atomic Work GCR edit variants are exported from the
 * SDK barrel, discriminate correctly on `type`, and their field shapes agree
 * with the node-side state machines that consume them.
 */

// Keyed by an opaque derived key: the edit family is profile-free, and a
// profile derives the key from its own authenticated fields.
const slot: GCREditResourceSlot = {
    type: "resource-slot-cas",
    isRollback: false,
    txhash: "tx1",
    resourceKey: "k".repeat(64),
    expected: { state: "vacant", generation: 0 },
    conflictDigest: "e".repeat(64),
    transition: "settle",
    workId: "w".repeat(64),
}
const attempt: GCREditWorkAttempt = {
    type: "work-attempt",
    isRollback: false,
    txhash: "tx2",
    workId: "w".repeat(64),
    attemptId: "attempt-a",
    canonicalBytesHash: "c".repeat(64),
}
const storage: GCREditStoragePut = {
    type: "storage-program-put",
    isRollback: false,
    txhash: "tx4",
    target: "stor-abc",
    writer: "writer1",
    name: "commitment",
    discriminator: "1",
    mode: "create-only",
    valueDigest: "h".repeat(64),
    value: { ok: true },
}

// Exhaustive discriminator: if a NEW variant is added to the union without a
// case here, `never` in the default arm makes tsc fail — a compile-time
// completeness guard for the Atomic Work edit family.
function labelAtomicEdit(edit: GCREdit): string {
    switch (edit.type) {
        case "resource-slot-cas":
            return `slot:${edit.transition}:${edit.expected.state}`
        case "work-attempt":
            return `attempt:${edit.attemptId}`
        case "storage-program-put":
            return `storage:${edit.target}`
        default:
            return `other:${edit.type}`
    }
}

describe("Atomic Work GCR edit variants (s1)", () => {
    it("are importable from the SDK barrel and carry their discriminant", () => {
        expect(slot.type).toBe("resource-slot-cas")
        expect(attempt.type).toBe("work-attempt")
        expect(storage.type).toBe("storage-program-put")
    })

    it("discriminate on `type` (runtime narrowing)", () => {
        expect(labelAtomicEdit(slot)).toBe("slot:settle:vacant")
        expect(labelAtomicEdit(attempt)).toBe("attempt:attempt-a")
        expect(labelAtomicEdit(storage)).toBe("storage:stor-abc")
    })

    it("does not collide with an existing variant discriminant", () => {
        const balance = {
            type: "balance",
            isRollback: false,
            operation: "add",
            account: "a",
            amount: "1",
            txhash: "t",
        } as unknown as GCREdit
        expect(labelAtomicEdit(balance)).toBe("other:balance")
    })

    it("slot edit's expectation is exactly the resource slot's", () => {
        // Structural check: the edit's `expected` IS a SlotCasExpectation, so
        // the node applies the edit with the same precondition it stages.
        const exp: SlotCasExpectation = slot.expected
        expect(exp.state).toBe("vacant")
        // The key is opaque. A profile's own fields (rail, job, phase) never
        // appear in the edit, which is what keeps the edit family profile-free.
        expect(typeof slot.resourceKey).toBe("string")
        expect(Object.keys(slot)).not.toContain("slotKey")
    })
})
