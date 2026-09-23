import { describe, expect, it } from "bun:test"
import { assertOsCanonicalAmount } from "@/libs/atomic-work/amountGuard"

describe("assertOsCanonicalAmount", () => {
    it("accepts a decimal-integer string", () => {
        expect(() => assertOsCanonicalAmount("1000000", "amount")).not.toThrow()
        expect(() => assertOsCanonicalAmount("0", "amount")).not.toThrow()
    })

    it("rejects JS numbers (fork-hash divergence risk, AW-19)", () => {
        expect(() =>
            assertOsCanonicalAmount(1000000 as unknown, "amount"),
        ).toThrow(/amount/)
    })

    it("rejects empty, non-digit, and decimal-point strings", () => {
        expect(() => assertOsCanonicalAmount("", "amount")).toThrow()
        expect(() => assertOsCanonicalAmount("1.5", "amount")).toThrow()
        expect(() => assertOsCanonicalAmount("0x10", "amount")).toThrow()
        expect(() => assertOsCanonicalAmount(" 10", "amount")).toThrow()
    })
})
