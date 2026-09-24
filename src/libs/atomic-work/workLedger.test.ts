import { describe, expect, it } from "bun:test"

import {
    applySlotCas,
    applyWorkAttempt,
    applyWorkReceipt,
    assertWorkEditSet,
    type SlotCasEdit,
    type SlotRecord,
    type WorkAttemptEdit,
    type WorkReceiptEdit,
    type WorkRecord,
} from "@/libs/atomic-work/workLedger"

const attempt = (over: Partial<WorkAttemptEdit> = {}): WorkAttemptEdit => ({
    type: "work-attempt",
    workId: "w1",
    attemptId: "a1",
    canonicalBytesHash: "h1",
    txhash: "tx1",
    ...over,
})

const receipt = (over: Partial<WorkReceiptEdit> = {}): WorkReceiptEdit => ({
    type: "work-receipt",
    workId: "w1",
    receiptCommitment: "r1",
    effectsRoot: "e1",
    inputHash: "i1",
    outputHash: "o1",
    ...over,
})

const slot = (over: Partial<SlotCasEdit> = {}): SlotCasEdit => ({
    type: "resource-slot-cas",
    resourceKey: "k1",
    expected: { state: "vacant", generation: 0 },
    transition: "settle",
    workId: "w1",
    conflictDigest: "c1",
    receiptCommitment: "r1",
    txhash: "tx1",
    ...over,
})

describe("work attempts", () => {
    it("records the first attempt as the winner and refuses a second", () => {
        const works = new Map<string, WorkRecord | null>()
        expect(applyWorkAttempt(attempt(), works, false).success).toBe(true)
        expect(works.get("w1")?.winnerAttemptId).toBe("a1")

        const second = applyWorkAttempt(attempt({ attemptId: "a2", canonicalBytesHash: "h2" }), works, false)
        expect(second.success).toBe(false)
        expect(second.message).toContain("already has a winning attempt")
    })

    it("accepts a replay of a Work that ran, without writing anything", () => {
        const works = new Map<string, WorkRecord | null>()
        applyWorkAttempt(attempt(), works, false)
        const before = structuredClone(works.get("w1"))

        const replay = applyWorkAttempt(attempt({ attemptId: "a2", attemptClass: "replay" }), works, false)
        expect(replay.success).toBe(true)
        expect(works.get("w1")).toEqual(before)
    })

    it("refuses a replay of a Work that never ran, or with different bytes", () => {
        const works = new Map<string, WorkRecord | null>()
        expect(applyWorkAttempt(attempt({ attemptClass: "replay" }), works, false).success).toBe(false)

        applyWorkAttempt(attempt(), works, false)
        const forged = applyWorkAttempt(
            attempt({ attemptId: "a2", attemptClass: "replay", canonicalBytesHash: "other" }),
            works,
            false,
        )
        expect(forged.success).toBe(false)
    })

    it("requires a replacement to name its prior, and forbids that for others", () => {
        const works = new Map<string, WorkRecord | null>()
        expect(applyWorkAttempt(attempt({ attemptClass: "replacement" }), works, false).success).toBe(false)
        expect(applyWorkAttempt(attempt({ replacementFor: "a0" }), works, false).success).toBe(false)
        expect(
            applyWorkAttempt(attempt({ attemptClass: "replacement", replacementFor: "a0" }), works, false).success,
        ).toBe(true)
    })

    it("undoes only the recorded winner on rollback", () => {
        const works = new Map<string, WorkRecord | null>()
        applyWorkAttempt(attempt(), works, false)
        expect(applyWorkAttempt(attempt({ attemptId: "zz" }), works, true).success).toBe(false)
        expect(applyWorkAttempt(attempt(), works, true).success).toBe(true)
        expect(works.get("w1")).toBeNull()
    })
})

describe("work receipts", () => {
    it("needs a winner, records once, and undoes only its own commitment", () => {
        const works = new Map<string, WorkRecord | null>()
        expect(applyWorkReceipt(receipt(), works, false).success).toBe(false)

        applyWorkAttempt(attempt(), works, false)
        expect(applyWorkReceipt(receipt(), works, false).success).toBe(true)
        expect(works.get("w1")?.receiptCommitment).toBe("r1")
        expect(applyWorkReceipt(receipt({ receiptCommitment: "r2" }), works, false).success).toBe(false)

        expect(applyWorkReceipt(receipt({ receiptCommitment: "r2" }), works, true).success).toBe(false)
        expect(applyWorkReceipt(receipt(), works, true).success).toBe(true)
        expect(works.get("w1")?.receiptCommitment).toBeNull()
    })
})

describe("resource slots", () => {
    it("settles a vacant slot and refuses a stale expectation", () => {
        const slots = new Map<string, SlotRecord | null>()
        expect(applySlotCas(slot(), slots, false).success).toBe(true)
        expect(slots.get("k1")).toMatchObject({ state: "settled", generation: 0, workId: "w1" })

        const again = applySlotCas(slot({ workId: "w2" }), slots, false)
        expect(again.success).toBe(false)
        expect(again.message).toContain("expected state vacant")
    })

    it("lets a rolled-back slot be retried and bumps the generation", () => {
        const slots = new Map<string, SlotRecord | null>()
        applySlotCas(slot({ transition: "rollback" }), slots, false)
        expect(slots.get("k1")?.state).toBe("rolled-back")

        const retry = applySlotCas(
            slot({ workId: "w2", expected: { state: "rolled-back", generation: 0 }, receiptCommitment: "r2" }),
            slots,
            false,
        )
        expect(retry.success).toBe(true)
        expect(slots.get("k1")).toMatchObject({ state: "settled", generation: 1, workId: "w2" })
    })

    it("restores exactly the replaced record on block rollback", () => {
        const slots = new Map<string, SlotRecord | null>()
        applySlotCas(slot({ transition: "rollback" }), slots, false)
        const rolledBack = slots.get("k1")!
        const retry = slot({ workId: "w2", expected: { state: "rolled-back", generation: 0 }, receiptCommitment: "r2" })
        applySlotCas(retry, slots, false)

        expect(applySlotCas(retry, slots, true).success).toBe(true)
        expect(slots.get("k1")).toEqual(rolledBack)
        expect(applySlotCas(slot({ transition: "rollback" }), slots, true).success).toBe(true)
        expect(slots.get("k1")).toBeNull()
    })

    it("refuses to leave a slot in flight on chain", () => {
        const slots = new Map<string, SlotRecord | null>()
        const reserve = applySlotCas(slot({ transition: "reserve" as never }), slots, false)
        expect(reserve.success).toBe(false)
        expect(slots.has("k1")).toBe(false)
    })
})

describe("the shape of a Work transaction", () => {
    it("accepts attempt, slots and receipt that agree", () => {
        expect(assertWorkEditSet([attempt(), slot(), receipt()]).success).toBe(true)
    })

    it("refuses two attempts, a missing receipt, or a receipt for another Work", () => {
        expect(assertWorkEditSet([attempt(), attempt({ attemptId: "a2" }), receipt()]).success).toBe(false)
        expect(assertWorkEditSet([attempt(), slot()]).success).toBe(false)
        expect(assertWorkEditSet([attempt(), receipt({ workId: "w9" })]).success).toBe(false)
    })

    it("refuses a slot that moves with another receipt, or twice", () => {
        expect(assertWorkEditSet([attempt(), slot({ receiptCommitment: "rX" }), receipt()]).success).toBe(false)
        expect(assertWorkEditSet([attempt(), slot(), slot(), receipt()]).success).toBe(false)
    })

    it("refuses a replay that carries effects", () => {
        expect(assertWorkEditSet([attempt({ attemptClass: "replay" })]).success).toBe(true)
        expect(assertWorkEditSet([attempt({ attemptClass: "replay" }), slot()]).success).toBe(false)
    })

    it("requires the attempt to lead", () => {
        expect(assertWorkEditSet([receipt(), attempt()]).success).toBe(false)
    })
})
