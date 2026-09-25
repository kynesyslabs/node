import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
    assertCasPrecondition,
    reserveSlot,
    settleSlot,
    rollbackSlot,
    SlotCasError,
    type SlotState,
} from "@/libs/atomic-work/resourceSlot"

// Published settle/rollback transitions lifted from the #336
// atomic-work-settlement-slot-v0.1 vectors (DACS-Standard @ 6a4dd2a): each is a
// real (before, outcome, workId, conflictDigest, receiptCommitment) -> after.
type TransitionFixture = {
    cases: {
        outcome: "committed" | "rolled-back"
        workId: string
        receiptCommitment: string
        before: SlotState
        after: Record<string, unknown>
    }[]
}
const fixture: TransitionFixture = JSON.parse(
    readFileSync(
        join(import.meta.dir, "__fixtures__/slot_transitions.vectors.json"),
        "utf-8",
    ),
)

describe("payment-slot terminal transitions — reconciliation vs #336 vectors", () => {
    it("has both committed and rolled-back, fresh and retry, cases", () => {
        const outcomes = new Set(fixture.cases.map(c => c.outcome))
        expect(outcomes.has("committed")).toBe(true)
        expect(outcomes.has("rolled-back")).toBe(true)
        expect(fixture.cases.some(c => c.before.state === "rolled-back")).toBe(true) // retry
        expect(fixture.cases.some(c => c.before.state === "vacant")).toBe(true) // fresh
    })

    for (const [i, c] of fixture.cases.entries()) {
        it(`reproduces published slot ${c.outcome} transition [case ${i}]`, () => {
            const after = c.after as Record<string, unknown>
            const produced =
                c.outcome === "committed"
                    ? settleSlot(
                          c.before,
                          after.workId as string,
                          after.conflictDigest as string,
                          after.receiptCommitment as string,
                      )
                    : rollbackSlot(
                          c.before,
                          after.workId as string,
                          after.conflictDigest as string,
                          after.failureReceiptCommitment as string,
                      )
            expect(produced).toEqual(c.after as never)
        })
    }
})

describe("payment-slot CAS + reserve", () => {
    it("bumps generation only on retry (rolled-back prior), never from vacant", () => {
        const fresh = settleSlot({ state: "vacant", generation: 5 }, "w", "d", "rc")
        expect(fresh.generation).toBe(5)
        const retry = settleSlot(
            { state: "rolled-back", generation: 5, workId: "w", conflictDigest: "d", failureReceiptCommitment: "f" },
            "w",
            "d",
            "rc",
        )
        expect(retry.generation).toBe(6)
    })

    it("reserve preserves generation and moves vacant -> in-flight", () => {
        const s = reserveSlot({ state: "vacant", generation: 3 }, { state: "vacant", generation: 3 }, "w1", "cd1")
        expect(s).toEqual({ state: "in-flight", generation: 3, workId: "w1", conflictDigest: "cd1" })
    })

    it("reserve from a rolled-back precondition preserves generation", () => {
        const stored: SlotState = { state: "rolled-back", generation: 2, workId: "w", conflictDigest: "d", failureReceiptCommitment: "f" }
        const s = reserveSlot(stored, { state: "rolled-back", generation: 2 }, "w2", "cd2")
        expect(s).toEqual({ state: "in-flight", generation: 2, workId: "w2", conflictDigest: "cd2" })
    })

    it("rejects a CAS state mismatch (compare-and-reject, like nonce)", () => {
        expect(() =>
            assertCasPrecondition({ state: "in-flight", generation: 1, workId: "w", conflictDigest: "d" }, { state: "vacant", generation: 1 }),
        ).toThrow(SlotCasError)
    })

    it("rejects a CAS generation mismatch (stale reservation)", () => {
        let err: unknown
        try {
            assertCasPrecondition({ state: "vacant", generation: 4 }, { state: "vacant", generation: 3 })
        } catch (e) {
            err = e
        }
        expect(err).toBeInstanceOf(SlotCasError)
        expect((err as SlotCasError).reason).toBe("generation-mismatch")
    })
})
