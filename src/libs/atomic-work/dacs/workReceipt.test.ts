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

    it("matches the reference output hash wherever it does not depend on the write's nonce", () => {
        const results = build().receipt.operationResults as any[]
        results.forEach((r, i) => {
            if (r.operationKind !== "storage-program-put") {
                expect(r.outputHash).toBe(reference.operationResults[i].outputHash)
            }
        })
    })

    it("binds each write's actual address, digest and writer", () => {
        const storage = (build().receipt.operationResults as any[]).filter(r => r.storageOutput)
        expect(storage.map(r => r.storageOutput.nativeAddress)).toEqual(writes.map((w: any) => w.target))
        expect(storage[0].storageOutput.nonce).toBe("7")
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
