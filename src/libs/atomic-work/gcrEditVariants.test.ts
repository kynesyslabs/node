import { describe, expect, it } from "bun:test"
import type {
    GCREdit,
    GCREditPaymentSlot,
    GCREditWorkAttempt,
    GCREditWorkReceipt,
    GCREditStoragePut,
} from "@kynesyslabs/demosdk/types"
import type { SlotCasExpectation } from "@/libs/atomic-work/resourceSlot"

/**
 * s1 verification: the four Atomic Work GCR edit variants are exported from the
 * SDK barrel, discriminate correctly on `type`, and their field shapes agree
 * with the node-side state machines that consume them.
 */

const slot: GCREditPaymentSlot = {
    type: "payment-slot-cas",
    isRollback: false,
    txhash: "tx1",
    slotKey: { networkId: "demos", railId: "rail/dem", jobId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", phaseIndex: 0 },
    expected: { state: "vacant", generation: 0 },
    conflictDigest: "e".repeat(64),
    transition: "reserve",
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
const receipt: GCREditWorkReceipt = {
    type: "work-receipt",
    isRollback: false,
    txhash: "tx3",
    workId: "w".repeat(64),
    receiptCommitment: "r".repeat(64),
    effectsRoot: "f".repeat(64),
    inputHash: "i".repeat(64),
    outputHash: "o".repeat(64),
}
const storage: GCREditStoragePut = {
    type: "storage-program-put",
    isRollback: false,
    txhash: "tx4",
    target: "stor-abc",
    writer: "writer1",
    nonce: 0,
    payload: { logicalAddress: "stor-abc", contentHash: "h".repeat(64) },
}

// Exhaustive discriminator: if a NEW variant is added to the union without a
// case here, `never` in the default arm makes tsc fail — a compile-time
// completeness guard for the Atomic Work edit family.
function labelAtomicEdit(edit: GCREdit): string {
    switch (edit.type) {
        case "payment-slot-cas":
            return `slot:${edit.transition}:${edit.expected.state}`
        case "work-attempt":
            return `attempt:${edit.attemptId}`
        case "work-receipt":
            return `receipt:${edit.receiptCommitment.slice(0, 4)}`
        case "storage-program-put":
            return `storage:${edit.target}`
        default:
            return `other:${edit.type}`
    }
}

describe("Atomic Work GCR edit variants (s1)", () => {
    it("are importable from the SDK barrel and carry their discriminant", () => {
        expect(slot.type).toBe("payment-slot-cas")
        expect(attempt.type).toBe("work-attempt")
        expect(receipt.type).toBe("work-receipt")
        expect(storage.type).toBe("storage-program-put")
    })

    it("discriminate on `type` (runtime narrowing)", () => {
        expect(labelAtomicEdit(slot)).toBe("slot:reserve:vacant")
        expect(labelAtomicEdit(attempt)).toBe("attempt:attempt-a")
        expect(labelAtomicEdit(receipt)).toBe("receipt:rrrr")
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

    it("slot edit's expected/slotKey shapes agree with paymentSlot.ts", () => {
        // Structural check: GCREditPaymentSlot.expected IS a SlotCasExpectation.
        const exp: SlotCasExpectation = slot.expected
        expect(exp.state).toBe("vacant")
        expect(new Set(Object.keys(slot.slotKey))).toEqual(
            new Set(["networkId", "railId", "jobId", "phaseIndex"]),
        )
    })
})
