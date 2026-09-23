import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
    selectWinner,
    assertBusinessEffectsFenced,
    assertReplacementsValid,
    AttemptLedgerError,
    type AttemptView,
} from "@/libs/atomic-work/attemptLedger"

// Attempt-ledger views + winners from the #336 pass vectors
// (atomic-work-execution-recovery-v0.1 @ 6a4dd2a).
type LedgerFixture = {
    cases: {
        attempts: AttemptView[]
        winningAttemptId: string | null
        businessEffectAttempts: string[]
        source: string
    }[]
    maxAttempts: number
}
const fx: LedgerFixture = JSON.parse(
    readFileSync(
        join(import.meta.dir, "__fixtures__/attempt_ledger.vectors.json"),
        "utf-8",
    ),
)

const ref = (v: string) => ({ kind: "test", value: v })
const att = (o: Partial<AttemptView> & { attemptId: string }): AttemptView => ({
    lifecycleState: null,
    nativeTransactionRef: ref(o.attemptId),
    attemptClass: "normal",
    ...o,
})

describe("attempt ledger — reconciliation vs #336 vectors", () => {
    it("covers winner, no-winner, and multi-attempt cases", () => {
        expect(fx.cases.some(c => c.winningAttemptId !== null)).toBe(true)
        expect(fx.cases.some(c => c.winningAttemptId === null)).toBe(true)
        expect(fx.maxAttempts).toBeGreaterThan(1)
    })

    for (const [i, c] of fx.cases.entries()) {
        it(`selects the published winner [case ${i}] (${c.source})`, () => {
            const winner = selectWinner(c.attempts)
            expect(winner).toBe(c.winningAttemptId)
            // fencing must accept the published business-effect set
            expect(() =>
                assertBusinessEffectsFenced(winner, c.businessEffectAttempts),
            ).not.toThrow()
        })
    }
})

describe("attempt ledger — invariants", () => {
    it("picks the single included attempt among many", () => {
        expect(
            selectWinner([
                att({ attemptId: "a", lifecycleState: "authoritative-non-inclusion" }),
                att({ attemptId: "b", lifecycleState: "included-committed" }),
                att({ attemptId: "c", lifecycleState: null }),
            ]),
        ).toBe("b")
    })

    it("returns null when no attempt is included", () => {
        expect(
            selectWinner([
                att({ attemptId: "a", lifecycleState: "authoritative-non-inclusion" }),
                att({ attemptId: "b", lifecycleState: null }),
            ]),
        ).toBeNull()
    })

    it("rejects two included attempts", () => {
        expect(() =>
            selectWinner([
                att({ attemptId: "a", lifecycleState: "included-committed" }),
                att({ attemptId: "b", lifecycleState: "included-rolled-back" }),
            ]),
        ).toThrow(AttemptLedgerError)
    })

    it("rejects a duplicate nativeTransactionRef (double-execution fence)", () => {
        let err: unknown
        try {
            selectWinner([
                att({ attemptId: "a", nativeTransactionRef: ref("same") }),
                att({ attemptId: "b", nativeTransactionRef: ref("same") }),
            ])
        } catch (e) {
            err = e
        }
        expect((err as AttemptLedgerError).reason).toBe("duplicate-native-ref")
    })

    it("rejects a duplicate attemptId", () => {
        expect(() =>
            selectWinner([att({ attemptId: "a" }), att({ attemptId: "a", nativeTransactionRef: ref("x") })]),
        ).toThrow(/duplicate attemptId/)
    })

    it("fences business effects to the winner", () => {
        expect(() => assertBusinessEffectsFenced("a", ["a"])).not.toThrow()
        expect(() => assertBusinessEffectsFenced("a", ["b"])).toThrow(AttemptLedgerError)
        expect(() => assertBusinessEffectsFenced(null, ["a"])).toThrow(AttemptLedgerError)
        expect(() => assertBusinessEffectsFenced("a", ["a", "a"])).toThrow(AttemptLedgerError)
    })

    it("allows replacing an authoritative-non-inclusion prior only", () => {
        const ok: AttemptView[] = [
            att({ attemptId: "p", lifecycleState: "authoritative-non-inclusion" }),
            att({ attemptId: "r", attemptClass: "replacement", replacementFor: "p", nativeTransactionRef: ref("r") }),
        ]
        expect(() => assertReplacementsValid(ok)).not.toThrow()

        const included: AttemptView[] = [
            att({ attemptId: "p", lifecycleState: "included-committed" }),
            att({ attemptId: "r", attemptClass: "replacement", replacementFor: "p", nativeTransactionRef: ref("r") }),
        ]
        expect(() => assertReplacementsValid(included)).toThrow(/cannot be replaced/)

        const unknown: AttemptView[] = [
            att({ attemptId: "r", attemptClass: "replacement", replacementFor: "ghost" }),
        ]
        expect(() => assertReplacementsValid(unknown)).toThrow(/unknown attempt/)
    })
})
