import { describe, expect, it } from "bun:test"

import {
    assertNotBefore,
    assertWithinDeadline,
    assertWithinWindow,
    DeadlineError,
    executionClock,
    ExecutionClockError,
} from "@/libs/atomic-work/executionClock"

const T = 1_700_000_000_000
const clock = executionClock(500, T)

describe("building a clock", () => {
    it("takes a block height and the time consensus agreed on", () => {
        expect(clock).toEqual({ blockHeight: 500, consensusTimeMs: T })
    })

    it("refuses a timestamp that is not a positive whole millisecond", () => {
        // Coercing a broken header would make expiry depend on the guess.
        for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 53]) {
            expect(() => executionClock(1, bad)).toThrow(ExecutionClockError)
        }
    })

    it("refuses a malformed height", () => {
        expect(() => executionClock(-1, T)).toThrow(/non-negative/)
        expect(() => executionClock(1.5, T)).toThrow(/non-negative/)
    })
})

describe("deadlines", () => {
    it("lets a Work through before its deadline", () => {
        expect(() => assertWithinDeadline(clock, T + 1)).not.toThrow()
    })

    it("counts a deadline exactly at this block as met", () => {
        // A deadline means "by then". Rejecting a Work for being punctual is
        // an off-by-one nobody can debug from a receipt.
        expect(() => assertWithinDeadline(clock, T)).not.toThrow()
    })

    it("refuses a Work one millisecond late", () => {
        let thrown: DeadlineError | undefined
        try {
            assertWithinDeadline(clock, T - 1, "the payment")
        } catch (error) {
            thrown = error as DeadlineError
        }

        expect(thrown?.reason).toBe("expired")
        expect(thrown?.consensusTimeMs).toBe(T)
        expect(thrown?.message).toContain("block 500")
    })

    it("refuses a Work presented before it is valid", () => {
        expect(() => assertNotBefore(clock, T + 1)).toThrow(/not valid until/)
        expect(() => assertNotBefore(clock, T)).not.toThrow()
    })
})

describe("with no clock at all", () => {
    /**
     * The failure being prevented: an absent time standing in for "now".
     * Treated as zero it expires everything; taken from the host clock it
     * expires different things on different validators.
     */
    it("refuses to judge a deadline", () => {
        let thrown: ExecutionClockError | undefined
        try {
            assertWithinDeadline(undefined, T + 1000, "the payment")
        } catch (error) {
            thrown = error as ExecutionClockError
        }

        expect(thrown?.reason).toBe("no-clock")
        expect(thrown?.message).toContain("consensus block time")
    })

    it("refuses a validity start and a window too", () => {
        expect(() => assertNotBefore(undefined, T)).toThrow(/none was supplied/)
        expect(() => assertWithinWindow(undefined, { deadlineMs: T })).toThrow(/none was supplied/)
    })
})

describe("a validity window", () => {
    it("accepts a Work inside it", () => {
        expect(() =>
            assertWithinWindow(clock, { notBeforeMs: T - 1000, deadlineMs: T + 1000 }),
        ).not.toThrow()
    })

    it("leaves an unset bound unconstrained", () => {
        expect(() => assertWithinWindow(clock, { deadlineMs: T + 1 })).not.toThrow()
        expect(() => assertWithinWindow(clock, { notBeforeMs: null, deadlineMs: null })).not.toThrow()
    })

    it("refuses a malformed bound rather than ignoring it", () => {
        expect(() => assertWithinDeadline(clock, Number.NaN)).toThrow(/malformed deadline/)
        expect(() => assertNotBefore(clock, 1.5)).toThrow(/malformed validity start/)
    })
})
