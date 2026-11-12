import { describe, expect, it } from "bun:test"
import { SeenAuthMessages } from "./authReplayCache"

describe("SeenAuthMessages", () => {
    it("refuses a message already used inside its window", () => {
        const seen = new SeenAuthMessages(10)
        expect(seen.claim("m", 1_000, 0)).toBe(true)
        expect(seen.claim("m", 1_000, 500)).toBe(false)
        expect(seen.claim("other", 1_000, 500)).toBe(true)
    })

    it("forgets a message once its window has passed", () => {
        const seen = new SeenAuthMessages(10)
        seen.claim("m", 1_000, 0)
        expect(seen.claim("m", 2_000, 1_001)).toBe(true)
    })

    it("drops expired messages instead of keeping them", () => {
        const seen = new SeenAuthMessages(10)
        for (let i = 0; i < 5; i++) seen.claim(`m${i}`, 100, 0)
        seen.claim("late", 1_000, 200)
        expect(seen.size).toBe(1)
    })

    it("never holds more than its bound, dropping the oldest", () => {
        const seen = new SeenAuthMessages(3)
        for (let i = 0; i < 1_000; i++) seen.claim(`m${i}`, 10_000, 0)
        expect(seen.size).toBe(3)
        expect(seen.claim("m999", 10_000, 1)).toBe(false)
        expect(seen.claim("m0", 10_000, 1)).toBe(true)
    })

    it("drops every expired message before a live one when full", () => {
        // Expiry follows the signer's timestamp, so a later claim can expire
        // first and sit behind a live one at the head.
        const seen = new SeenAuthMessages(3)
        seen.claim("live", 1_000, 0)
        seen.claim("b", 100, 0)
        seen.claim("c", 100, 0)
        expect(seen.claim("d", 1_000, 200)).toBe(true)
        expect(seen.claim("live", 1_000, 200)).toBe(false)
    })

    it("evicts the entry closest to expiry when every entry is live", () => {
        const seen = new SeenAuthMessages(3)
        seen.claim("late", 9_000, 0)
        seen.claim("soon", 1_000, 0)
        seen.claim("mid", 5_000, 0)
        expect(seen.claim("new", 9_000, 10)).toBe(true)
        expect(seen.claim("late", 9_000, 10)).toBe(false)
        expect(seen.claim("mid", 9_000, 10)).toBe(false)
    })

    it("stays fast when full of live entries", () => {
        const seen = new SeenAuthMessages(50_000)
        for (let i = 0; i < 50_000; i++) seen.claim(`live${i}`, 1_000_000 + i, 0)
        const started = performance.now()
        for (let i = 0; i < 2_000; i++) seen.claim(`new${i}`, 1_000_000, 1)
        // A full scan per claim takes seconds here; ordered upkeep, milliseconds.
        expect(performance.now() - started).toBeLessThan(500)
        expect(seen.size).toBe(50_000)
    })
})
