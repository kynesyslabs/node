import { describe, expect, it } from "bun:test"
import { nextAuthTimestamp } from "./peerHttpAuth"

describe("nextAuthTimestamp", () => {
    it("increases within one millisecond", () => {
        const a = nextAuthTimestamp(5_000_000_000_000)
        expect(nextAuthTimestamp(5_000_000_000_000)).toBe(a + 1)
    })

    it("follows the clock back after a large correction, so receivers do not refuse it as future-dated", () => {
        nextAuthTimestamp(6_000_000_000_000)
        const corrected = 6_000_000_000_000 - 10 * 60_000
        expect(nextAuthTimestamp(corrected)).toBe(corrected)
    })
})
