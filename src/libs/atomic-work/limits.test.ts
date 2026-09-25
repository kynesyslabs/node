import { describe, expect, it } from "bun:test"

import {
    assertExecutionWithinBudget,
    assertIntentWithinLimits,
    assertProofWithinLimits,
    canonicalByteLength,
    DEFAULT_ATOMIC_WORK_LIMITS,
    LimitExceededError,
    type AtomicWorkLimits,
} from "@/libs/atomic-work/limits"

const limits: AtomicWorkLimits = {
    maxCanonicalBytes: 200,
    maxOperations: 3,
    maxExecutionTimeMs: 50,
    maxProofBytes: 100,
}

const op = (id: string) => ({ operationId: id, kind: "storage-program-put" })

describe("size and shape, before anything executes", () => {
    it("admits a Work inside every bound", () => {
        expect(() =>
            assertIntentWithinLimits({ operations: [op("a"), op("b")] }, limits),
        ).not.toThrow()
    })

    it("refuses one operation too many", () => {
        let thrown: LimitExceededError | undefined
        try {
            assertIntentWithinLimits(
                { operations: [op("a"), op("b"), op("c"), op("d")] },
                limits,
            )
        } catch (error) {
            thrown = error as LimitExceededError
        }

        expect(thrown?.limit).toBe("maxOperations")
        expect(thrown?.actual).toBe(4)
        expect(thrown?.allowed).toBe(3)
    })

    it("accepts a Work exactly at the operation bound", () => {
        expect(() =>
            assertIntentWithinLimits({ operations: [op("a"), op("b"), op("c")] }, limits),
        ).not.toThrow()
    })

    it("measures canonical bytes, not the bytes that arrived", () => {
        // The received form can be padded or minified without changing what is
        // hashed, so limiting it would limit formatting rather than size.
        const intent = { operations: [op("a")], note: "x".repeat(300) }

        expect(() => assertIntentWithinLimits(intent, limits)).toThrow(/canonical bytes/)
        expect(canonicalByteLength({ a: 1 })).toBe(canonicalByteLength({ a: 1 }))
    })
})

describe("proof size", () => {
    it("refuses a proof too large to be worth verifying", () => {
        expect(() => assertProofWithinLimits(101, limits)).toThrow(/at most 100/)
        expect(() => assertProofWithinLimits(100, limits)).not.toThrow()
    })
})

describe("the execution budget", () => {
    it("aborts a Work that ran past it", () => {
        let thrown: LimitExceededError | undefined
        try {
            assertExecutionWithinBudget(51, limits)
        } catch (error) {
            thrown = error as LimitExceededError
        }

        expect(thrown?.limit).toBe("maxExecutionTimeMs")
        expect(thrown?.message).toContain("rolling back")
    })

    it("leaves a Work exactly at the budget alone", () => {
        expect(() => assertExecutionWithinBudget(50, limits)).not.toThrow()
    })
})

describe("the published defaults", () => {
    it("are whole positive numbers a submitter can plan against", () => {
        for (const [name, value] of Object.entries(DEFAULT_ATOMIC_WORK_LIMITS)) {
            expect(Number.isSafeInteger(value), name).toBe(true)
            expect(value, name).toBeGreaterThan(0)
        }
    })
})
