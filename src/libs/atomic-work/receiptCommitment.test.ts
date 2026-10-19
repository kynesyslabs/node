import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
    computeReceiptCommitment,
} from "@/libs/atomic-work/receiptCommitment"
import { DACS_DOMAINS } from "@/libs/atomic-work/dacs/domains"
import { registerDacsAtomicWorkProfiles } from "@/libs/atomic-work/dacs/profile"

registerDacsAtomicWorkProfiles()
const WORK_RECEIPT_DOMAIN = DACS_DOMAINS.workReceipt

// Real atomic-work receipts + their PUBLISHED receiptCommitment, lifted from the
// #336 conformance vectors (DACS-Standard atomic-work-*-v0.1 @ 6a4dd2a). Spans
// both the dacs-purchase-v1 profile (payment-slot `after` fields projected out)
// and dacs-completion-v1 (they are not).
type ReceiptFixture = {
    domain: string
    cases: {
        receiptCommitment: string
        source: string
        profile: string | null
        receipt: Record<string, unknown>
    }[]
}
const fixture: ReceiptFixture = JSON.parse(
    readFileSync(
        join(import.meta.dir, "__fixtures__/receipt_commitment.vectors.json"),
        "utf-8",
    ),
)

describe("computeReceiptCommitment — reconciliation vs published #336 vectors", () => {
    it("pins the reference domain", () => {
        expect(WORK_RECEIPT_DOMAIN).toBe(fixture.domain)
    })

    it("covers both purchase and completion profiles", () => {
        const profiles = new Set(fixture.cases.map(c => c.profile))
        expect(profiles.has("dacs-purchase-v1")).toBe(true)
        expect(profiles.has("dacs-completion-v1")).toBe(true)
    })

    for (const [i, c] of fixture.cases.entries()) {
        it(`reproduces published receiptCommitment [case ${i}] (${c.source})`, () => {
            expect(computeReceiptCommitment(c.receipt, WORK_RECEIPT_DOMAIN)).toBe(c.receiptCommitment)
        })
    }

    it("does not mutate the input receipt", () => {
        const c = fixture.cases[0]
        const before = JSON.stringify(c.receipt)
        computeReceiptCommitment(c.receipt, WORK_RECEIPT_DOMAIN)
        expect(JSON.stringify(c.receipt)).toBe(before)
    })
})
