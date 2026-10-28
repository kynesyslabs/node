/**
 * A member signs only whole-second timestamps that lead its clock by at most
 * a few seconds, so the secretary cannot try many timestamps for one block.
 */

import { describe, expect, it } from "bun:test"
import { COSIGN_TIMESTAMP_MAX_LEAD_SECONDS, checkCosignTimestamp } from "./cosignTimestamp"

const NOW = 1_700_000_000

describe("checkCosignTimestamp", () => {
    it("accepts a timestamp in our past or at our clock", () => {
        expect(checkCosignTimestamp(NOW - 30, NOW)).toEqual({ valid: true })
        expect(checkCosignTimestamp(NOW, NOW)).toEqual({ valid: true })
    })

    it("accepts a lead up to the allowed skew and refuses one second more", () => {
        expect(checkCosignTimestamp(NOW + COSIGN_TIMESTAMP_MAX_LEAD_SECONDS, NOW).valid).toBe(true)
        const verdict = checkCosignTimestamp(NOW + COSIGN_TIMESTAMP_MAX_LEAD_SECONDS + 1, NOW)
        expect(verdict.valid).toBe(false)
        expect(verdict.reason).toContain("ahead of our clock")
    })

    it("refuses a timestamp as far ahead as sync would still accept", () => {
        expect(checkCosignTimestamp(NOW + 60, NOW).valid).toBe(false)
    })

    it("refuses fractional and non-finite timestamps", () => {
        for (const value of [NOW - 0.5, NOW + 0.000001, Number.NaN, Number.POSITIVE_INFINITY]) {
            const verdict = checkCosignTimestamp(value, NOW)
            expect(verdict.valid).toBe(false)
            expect(verdict.reason).toContain("not a whole number")
        }
    })

    it("refuses a timestamp that is not a number", () => {
        for (const value of [String(NOW), null, undefined, { at: NOW }]) {
            expect(checkCosignTimestamp(value, NOW).valid).toBe(false)
        }
    })
})
