import { describe, expect, it } from "bun:test"

import {
    applySlotCas,
    applyWorkAttempt,
    assertWorkEditSet,
    contendedWorkTxs,
    sealWork,
    type SlotCasEdit,
    type SlotRecord,
    type WorkAttemptEdit,
    type WorkRecord,
} from "@/libs/atomic-work/workLedger"

const SENDER = "0xAbC"

const attempt = (over: Partial<WorkAttemptEdit> = {}): WorkAttemptEdit => ({
    type: "work-attempt",
    workId: "w1",
    attemptId: "a1",
    canonicalBytesHash: "h1",
    txhash: "tx1",
    ...over,
})

const slot = (over: Partial<SlotCasEdit> = {}): SlotCasEdit => ({
    type: "resource-slot-cas",
    resourceKey: "k1",
    expected: { state: "vacant", generation: 0 },
    transition: "settle",
    workId: "w1",
    conflictDigest: "c1",
    txhash: "tx1",
    ...over,
})

const senderReceipt = { type: "work-receipt", workId: "w1" }

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

    it("undoes only the recorded winner on rollback, receipt and all", () => {
        const works = new Map<string, WorkRecord | null>()
        const slots = new Map<string, SlotRecord | null>()
        applyWorkAttempt(attempt(), works, false)
        sealWork("w1", { r: 1 }, "rc", "root", [], works, slots)
        expect(applyWorkAttempt(attempt({ attemptId: "zz" }), works, true).success).toBe(false)
        expect(applyWorkAttempt(attempt(), works, true).success).toBe(true)
        expect(works.get("w1")).toBeNull()
    })
})

describe("sealing a Work", () => {
    it("writes the node's receipt onto the Work and every slot it moved", () => {
        const works = new Map<string, WorkRecord | null>()
        const slots = new Map<string, SlotRecord | null>()
        applyWorkAttempt(attempt(), works, false)
        applySlotCas(slot(), slots, false)
        applySlotCas(slot({ resourceKey: "k2", transition: "rollback" }), slots, false)

        expect(sealWork("w1", { outcome: "committed" }, "rc", "root", ["k1", "k2"], works, slots).success).toBe(true)
        expect(works.get("w1")).toMatchObject({ receiptCommitment: "rc", operationReceiptRoot: "root", receipt: { outcome: "committed" } })
        expect(slots.get("k1")).toMatchObject({ state: "settled", receiptCommitment: "rc" })
        expect(slots.get("k2")).toMatchObject({ state: "rolled-back", failureReceiptCommitment: "rc" })
    })

    it("seals once, and only slots this Work moved", () => {
        const works = new Map<string, WorkRecord | null>()
        const slots = new Map<string, SlotRecord | null>()
        applyWorkAttempt(attempt(), works, false)
        applySlotCas(slot({ workId: "other" }), slots, false)

        expect(sealWork("w1", {}, "rc", "root", ["k1"], works, slots).success).toBe(false)
        expect(sealWork("w9", {}, "rc", "root", [], works, slots).success).toBe(false)
        expect(sealWork("w1", {}, "rc", "root", [], works, slots).success).toBe(true)
        expect(sealWork("w1", {}, "rc2", "root", [], works, slots).success).toBe(false)
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

        const retry = applySlotCas(slot({ workId: "w2", expected: { state: "rolled-back", generation: 0 } }), slots, false)
        expect(retry.success).toBe(true)
        expect(slots.get("k1")).toMatchObject({ state: "settled", generation: 1, workId: "w2" })
    })

    it("restores exactly the replaced record on block rollback", () => {
        const slots = new Map<string, SlotRecord | null>()
        applySlotCas(slot({ transition: "rollback" }), slots, false)
        const rolledBack = slots.get("k1")!
        const retry = slot({ workId: "w2", expected: { state: "rolled-back", generation: 0 } })
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
    it("accepts an attempt with the slots it moves", () => {
        expect(assertWorkEditSet([attempt(), slot()], SENDER).success).toBe(true)
    })

    it("refuses two attempts, and any receipt from the sender", () => {
        expect(assertWorkEditSet([attempt(), attempt({ attemptId: "a2" })], SENDER).success).toBe(false)
        const withReceipt = assertWorkEditSet([attempt(), slot(), senderReceipt], SENDER)
        expect(withReceipt.success).toBe(false)
        expect(withReceipt.message).toContain("built by the node")
    })

    it("refuses a slot for another Work, or moved twice", () => {
        expect(assertWorkEditSet([attempt(), slot({ workId: "w9" })], SENDER).success).toBe(false)
        expect(assertWorkEditSet([attempt(), slot(), slot()], SENDER).success).toBe(false)
    })

    it("refuses a replay that carries effects", () => {
        expect(assertWorkEditSet([attempt({ attemptClass: "replay" })], SENDER).success).toBe(true)
        expect(assertWorkEditSet([attempt({ attemptClass: "replay" }), slot()], SENDER).success).toBe(false)
    })

    it("requires the attempt to lead", () => {
        expect(assertWorkEditSet([slot(), attempt()], SENDER).success).toBe(false)
    })
})

describe("storage writes in a Work", () => {
    const put = (writer: string, target = "stor-1") => ({ type: "storage-program-put", writer, target })

    it("must be written by the sender, once per address", () => {
        expect(assertWorkEditSet([attempt(), put("0xabc") as never], SENDER).success).toBe(true)
        expect(assertWorkEditSet([attempt(), put("0xdef") as never], SENDER).success).toBe(false)
        expect(assertWorkEditSet([attempt(), put("0xabc") as never, put("0xabc") as never], SENDER).success).toBe(false)
    })
})

describe("contendedWorkTxs", () => {
    const tx = (hash: string, edits: unknown[]) => ({ hash, content: { gcr_edits: edits as { type: string }[] } })

    it("refuses later transactions touching Work state an earlier one in the block touches", () => {
        const contended = contendedWorkTxs([
            tx("t1", [attempt(), slot()]),
            tx("t2", [attempt({ workId: "w2" }), slot({ workId: "w2" })]),
            tx("t3", [attempt({ workId: "w3" }), slot({ workId: "w3", resourceKey: "k3" })]),
            tx("t4", [{ type: "balance" }]),
            tx("t5", [attempt({ attemptClass: "replay", attemptId: "a9" })]),
        ])
        // t2 reuses slot k1; t5 replays Work w1, already touched by t1.
        expect([...contended].sort()).toEqual(["t2", "t5"])
    })
})
