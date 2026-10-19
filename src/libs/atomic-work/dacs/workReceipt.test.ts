import { beforeAll, describe, expect, it } from "bun:test"

import receipts from "@/libs/atomic-work/__fixtures__/receipt_commitment.vectors.json"
import intents from "@/libs/atomic-work/__fixtures__/workid.vectors.json"
import { DACS_PURCHASE_PROFILE, registerDacsAtomicWorkProfiles } from "@/libs/atomic-work/dacs/profile"
import { computeReceiptCommitment } from "@/libs/atomic-work/receiptCommitment"
import { buildWorkReceipt } from "@/libs/atomic-work/workReceipt"

const intent = (intents as any).cases[0].intent
const reference = (receipts as any).cases[0].receipt

const writes = reference.operationResults
    .filter((r: any) => r.operationKind === "storage-program-put")
    .map((r: any) => ({ target: r.storageOutput.nativeAddress, writer: r.storageOutput.writer, valueDigest: r.storageOutput.contentHash }))

const build = (over: Record<string, unknown> = {}) =>
    buildWorkReceipt({
        intent,
        profile: DACS_PURCHASE_PROFILE,
        workId: reference.workId,
        attemptId: "attempt-a",
        txHash: "0xtx",
        height: 901,
        nonce: 7,
        writes,
        ...over,
    })

beforeAll(() => registerDacsAtomicWorkProfiles())

describe("buildWorkReceipt", () => {
    it("hashes each operation's input exactly as the reference receipt does", () => {
        const { receipt } = build()
        const results = receipt.operationResults as any[]
        expect(results.map(r => r.inputHash)).toEqual(reference.operationResults.map((r: any) => r.inputHash))
    })

    it("matches every reference output hash, storage writes included", () => {
        // The reference numbers writes from the transaction's nonce by
        // operation index (200, 201, 203 for operations 0, 1, 3).
        const results = build({ nonce: 200 }).receipt.operationResults as any[]
        expect(results.map(r => r.outputHash)).toEqual(reference.operationResults.map((r: any) => r.outputHash))
        expect(results.filter(r => r.storageOutput).map(r => r.storageOutput.nonce)).toEqual(["200", "201", "203"])
    })

    it("binds each write's actual address, digest and writer", () => {
        const storage = (build().receipt.operationResults as any[]).filter(r => r.storageOutput)
        expect(storage.map(r => r.storageOutput.nativeAddress)).toEqual(writes.map((w: any) => w.target))
        expect(storage.map(r => r.storageOutput.nonce)).toEqual(["7", "8", "10"])
    })

    it("pairs each write with the operation whose value it wrote, not by position", () => {
        const reordered = build({ writes: [writes[2], writes[0], writes[1]] })
        const storage = (reordered.receipt.operationResults as any[]).filter(r => r.storageOutput)
        expect(storage.map(r => r.storageOutput.nativeAddress)).toEqual(writes.map((w: any) => w.target))
        expect(reordered.receiptCommitment).toBe(build().receiptCommitment)
    })

    it("refuses a write whose value no operation declares", () => {
        const swapped = [{ ...writes[0], valueDigest: writes[1].valueDigest }, writes[1], writes[2]]
        expect(() => build({ writes: swapped })).toThrow("did not make with its value")
    })

    it("commits to the slots it moved and the payments it made", () => {
        const slot = {
            resourceKey: "k1",
            before: { state: "vacant", generation: 0 },
            after: { state: "settled", generation: 0, workId: reference.workId, conflictDigest: "c1" },
        }
        const pay = { from: "0xaa", to: "0xbb", amount: "10" }
        const { receipt, receiptCommitment } = build({ slots: [slot], transfers: [pay] })
        expect(receipt.effects).toEqual({
            slots: [slot],
            transfers: [pay],
            writes: writes.map((w: any) => ({ nativeAddress: w.target, contentHash: w.valueDigest })),
        })
        expect(receipt.effectsRoot).toMatch(/^[0-9a-f]{64}$/)
        const otherAfter = { ...slot, after: { ...slot.after, generation: 1 } }
        expect(build({ slots: [otherAfter], transfers: [pay] }).receiptCommitment).not.toBe(receiptCommitment)
    })

    it("reports a Work that rolled its slot back as rolled back, not committed", () => {
        const slot = {
            resourceKey: "k1",
            before: { state: "vacant", generation: 0 },
            after: { state: "rolled-back", generation: 0, workId: reference.workId, conflictDigest: "c1" },
        }
        const { receipt } = build({ writes: [], slots: [slot] })
        expect(receipt.outcome).toBe("rolled-back")
        const statuses = (receipt.operationResults as any[]).map(r => [r.operationKind, r.status])
        expect(statuses).toEqual(reference.operationResults.map((r: any) => [
            r.operationKind,
            r.operationKind === "native-dem-transfer" ? "not-executed" : "rolled-back",
        ]))
        expect((receipt.operationResults as any[]).every(r => r.outputHash === undefined)).toBe(true)

        expect(() => build({ slots: [slot] })).toThrow("cannot have written storage")
    })

    it("commits to itself the way any verifier would recompute it", () => {
        const { receipt, receiptCommitment } = build()
        expect(computeReceiptCommitment(receipt, DACS_PURCHASE_PROFILE.domains.workReceipt)).toBe(receiptCommitment)
        expect(receipt.receiptCommitment).toBe(receiptCommitment)
    })

    it("is deterministic, and changes with the block or the transaction", () => {
        expect(build().receiptCommitment).toBe(build().receiptCommitment)
        expect(build({ height: 902 }).receiptCommitment).not.toBe(build().receiptCommitment)
        expect(build({ txHash: "0xother" }).receiptCommitment).not.toBe(build().receiptCommitment)
    })

    it("refuses writes the operations do not account for", () => {
        expect(() => build({ writes: writes.slice(1) })).toThrow("did not make")
        expect(() => build({ writes: [...writes, writes[0]] })).toThrow("do not declare")
    })
})
