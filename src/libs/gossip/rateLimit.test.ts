import { describe, expect, it } from "bun:test"
import { TxRateLimiter } from "./rateLimit"

const make = (now: { t: number }, overrides = {}) =>
    new TxRateLimiter(
        {
            publisherMessages: { ratePerSec: 10, burst: 20 },
            publisherBytes: { ratePerSec: 1000, burst: 5000 },
            globalMessages: { ratePerSec: 100, burst: 30 },
            ...overrides,
        },
        () => now.t,
    )

describe("TxRateLimiter", () => {
    it("admits up to the burst then refuses", () => {
        const now = { t: 0 }
        const rl = make(now)
        for (let i = 0; i < 20; i++) expect(rl.admit("A", 10)).toBe("ok")
        expect(rl.admit("A", 10)).toBe("publisher_rate")
    })

    it("refills at the sustained rate", () => {
        const now = { t: 0 }
        const rl = make(now)
        for (let i = 0; i < 20; i++) rl.admit("A", 10)
        now.t = 500
        expect(rl.admit("A", 10)).toBe("ok")
        for (let i = 0; i < 4; i++) rl.admit("A", 10)
        expect(rl.admit("A", 10)).toBe("publisher_rate")
    })

    it("limits bytes independently and does not charge the message on refusal", () => {
        const now = { t: 0 }
        const rl = make(now)
        expect(rl.admit("A", 4000)).toBe("ok")
        expect(rl.admit("A", 2000)).toBe("publisher_bytes")
        expect(rl.admit("A", 1000)).toBe("ok")
    })

    it("isolates publishers and applies the global bucket", () => {
        const now = { t: 0 }
        const rl = make(now)
        for (let i = 0; i < 20; i++) expect(rl.admit("A", 1)).toBe("ok")
        for (let i = 0; i < 10; i++) expect(rl.admit("B", 1)).toBe("ok")
        expect(rl.admit("C", 1)).toBe("global_rate")
        expect(rl.admit("A", 1)).toBe("publisher_rate")
    })

    it("treats publisher keys case-insensitively", () => {
        const now = { t: 0 }
        const rl = make(now)
        for (let i = 0; i < 20; i++) rl.admit("0xAB", 1)
        expect(rl.admit("0xab", 1)).toBe("publisher_rate")
        expect(rl.size()).toBe(1)
    })

    it("evicts idle publishers when full", () => {
        const now = { t: 0 }
        const rl = make(now, { maxPublishers: 2, publisherTtlMs: 1000 })
        rl.admit("A", 1)
        now.t = 10
        rl.admit("B", 1)
        now.t = 2000
        rl.admit("C", 1)
        expect(rl.size()).toBe(1)
    })
})
