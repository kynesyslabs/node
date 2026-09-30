import { describe, expect, it } from "bun:test"

import {
    assertSingleCharge,
    settlementFor,
    SettlementError,
    type WorkOutcome,
} from "@/libs/atomic-work/feeAndNonce"

describe("what each ending costs", () => {
    it("charges a Work that executed, whether or not its effects stood", () => {
        // Free failure is an unlimited retry: a Work that cannot succeed could
        // be resubmitted until the state happened to suit it.
        expect(settlementFor("committed")).toMatchObject({ chargeFee: true, consumeNonce: true })
        expect(settlementFor("rolled-back")).toMatchObject({ chargeFee: true, consumeNonce: true })
    })

    it("charges nothing for a Work that never executed", () => {
        for (const outcome of ["refused-at-admission", "dropped", "expired"] as WorkOutcome[]) {
            expect(settlementFor(outcome).chargeFee).toBe(false)
            expect(settlementFor(outcome).consumeNonce).toBe(false)
        }
    })

    it("does not burn the nonce of an attempt the chain never included", () => {
        // Otherwise the account stalls behind a transaction nobody can find.
        expect(settlementFor("replaced")).toMatchObject({ chargeFee: false, consumeNonce: false })
    })

    it("does not charge again to hand back a receipt", () => {
        expect(settlementFor("replayed").chargeFee).toBe(false)
    })

    it("states a reason for each, so a receipt can say why", () => {
        const outcomes: WorkOutcome[] = [
            "refused-at-admission", "committed", "rolled-back",
            "replaced", "dropped", "expired", "replayed",
        ]
        for (const outcome of outcomes) {
            expect(settlementFor(outcome).rationale.length).toBeGreaterThan(10)
        }
    })

    it("refuses an outcome nobody defined a rule for", () => {
        expect(() => settlementFor("invented" as WorkOutcome)).toThrow(SettlementError)
    })
})

describe("one Work, one charge", () => {
    it("allows the attempts a real lifecycle produces", () => {
        expect(() =>
            assertSingleCharge(["replaced", "committed", "replayed"]),
        ).not.toThrow()
        expect(() => assertSingleCharge(["rolled-back", "replayed"])).not.toThrow()
    })

    it("catches a Work billed twice across its attempts", () => {
        let thrown: SettlementError | undefined
        try {
            assertSingleCharge(["committed", "rolled-back"])
        } catch (error) {
            thrown = error as SettlementError
        }

        expect(thrown?.reason).toBe("double-charge")
    })

    it("catches a nonce consumed twice", () => {
        expect(() => assertSingleCharge(["committed", "committed"])).toThrow(
            /charged 2 times|consumed the nonce/,
        )
    })
})

describe("settling a Work transaction's edits", () => {
    const { splitSettlement, settledEdits } = require("@/libs/atomic-work/feeAndNonce")
    const kinds = new Set(["work-attempt", "resource-slot-cas"])
    const edits = [
        { type: "work-attempt" },
        { type: "balance", n: "transfer-out" },
        { type: "balance", n: "transfer-in" },
        { type: "resource-slot-cas" },
        { type: "balance", n: "gas" },
        { type: "nonce" },
    ]
    const parts = splitSettlement(edits, kinds, 1)

    it("finds the envelope after the Work's own edits and transfers", () => {
        expect(parts.work.map((e: any) => e.n ?? e.type)).toEqual(["work-attempt", "transfer-out", "transfer-in", "resource-slot-cas"])
        expect(parts.fee).toEqual([{ type: "balance", n: "gas" }])
        expect(parts.nonce).toEqual([{ type: "nonce" }])
    })

    it("charges a rolled-back Work its fee and nonce but none of its effects", () => {
        expect(settledEdits(parts, "rolled-back", false)).toEqual([...parts.fee, ...parts.nonce])
    })

    it("lets a replay spend its nonce without paying again", () => {
        expect(settledEdits(parts, "replayed", true)).toEqual([...parts.work, ...parts.nonce])
    })
})
