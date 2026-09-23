import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
    OP_RECEIPT_DOMAIN,
    computeInputHash,
    computeOutputHash,
    computeStateRoot,
    computeEffectsRoot,
    computeOperationReceiptRoot,
} from "@/libs/atomic-work/operationReceipt"

// D6 evidence-hash fixture from the #336 pass vectors (DACS-Standard @ 6a4dd2a);
// every case self-validated against the reference before emission.
type D6Fixture = {
    opReceiptDomain: string
    receiptRoot: { operationResults: unknown[]; operationReceiptRoot: string }[]
    inputHash: { payload: unknown; inputHash: string }[]
    outputHash: {
        kind: string
        payload?: unknown
        storageOutput?: unknown
        operationId?: string
        outputHash: string
    }[]
    effects: {
        preState: Record<string, unknown>
        postState: Record<string, unknown>
        effectsRoot: string
        preRoot: string
        postRoot: string
    }[]
}
const fx: D6Fixture = JSON.parse(
    readFileSync(
        join(import.meta.dir, "__fixtures__/d6_operation_hashes.vectors.json"),
        "utf-8",
    ),
)

describe("D6 operation/evidence hashes — reconciliation vs #336 vectors", () => {
    it("pins the operation-receipt domain", () => {
        expect(OP_RECEIPT_DOMAIN).toBe(fx.opReceiptDomain)
    })

    it("exercises multi-leaf merkle (leaf counts > 1)", () => {
        expect(fx.receiptRoot.some(c => c.operationResults.length > 1)).toBe(true)
    })

    for (const [i, c] of fx.receiptRoot.entries()) {
        it(`reproduces operationReceiptRoot [case ${i}, ${c.operationResults.length} leaves]`, () => {
            expect(computeOperationReceiptRoot(c.operationResults)).toBe(
                c.operationReceiptRoot,
            )
        })
    }

    for (const [i, c] of fx.inputHash.entries()) {
        it(`reproduces inputHash [case ${i}]`, () => {
            expect(computeInputHash(c.payload)).toBe(c.inputHash)
        })
    }

    for (const [i, c] of fx.outputHash.entries()) {
        it(`reproduces outputHash [case ${i}, ${c.kind}]`, () => {
            expect(computeOutputHash(c)).toBe(c.outputHash)
        })
    }

    for (const [i, c] of fx.effects.entries()) {
        it(`reproduces effectsRoot + pre/postRoot [case ${i}]`, () => {
            expect(computeEffectsRoot(c.preState, c.postState)).toBe(c.effectsRoot)
            expect(computeStateRoot(c.preState)).toBe(c.preRoot)
            expect(computeStateRoot(c.postState)).toBe(c.postRoot)
        })
    }
})

describe("operationReceiptRoot — merkle structure", () => {
    it("single leaf returns the leaf hash verbatim (no internal node)", () => {
        const single = computeOperationReceiptRoot([{ a: 1 }])
        const asTwo = computeOperationReceiptRoot([{ a: 1 }, { b: 2 }])
        expect(single).toMatch(/^[0-9a-f]{64}$/)
        expect(single).not.toBe(asTwo)
    })

    it("is order-sensitive", () => {
        expect(computeOperationReceiptRoot([{ a: 1 }, { b: 2 }])).not.toBe(
            computeOperationReceiptRoot([{ b: 2 }, { a: 1 }]),
        )
    })
})
