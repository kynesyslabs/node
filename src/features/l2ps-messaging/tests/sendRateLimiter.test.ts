/**
 * The per-key send limit of the messaging relay.
 */

import { describe, expect, it } from "bun:test"
import { SendRateLimiter } from "../sendRateLimiter"

let clock = 1_000_000

function limiter(ratePerSec = 5, burst = 30) {
    return new SendRateLimiter({ ratePerSec, burst, now: () => clock })
}

describe("SendRateLimiter", () => {
    it("allows a burst, then refuses with the wait until the next token", () => {
        clock = 1_000_000
        const l = limiter(5, 30)
        for (let i = 0; i < 30; i++) expect(l.take("a")).toEqual({ allowed: true, retryAfterMs: 0 })

        expect(l.take("a")).toEqual({ allowed: false, retryAfterMs: 200 })
    })

    it("refills at the configured rate", () => {
        clock = 1_000_000
        const l = limiter(5, 30)
        for (let i = 0; i < 30; i++) l.take("a")

        clock += 1000
        for (let i = 0; i < 5; i++) expect(l.take("a").allowed).toBe(true)
        expect(l.take("a").allowed).toBe(false)
    })

    it("keeps each key's bucket separate", () => {
        clock = 1_000_000
        const l = limiter(1, 1)
        expect(l.take("a").allowed).toBe(true)
        expect(l.take("a").allowed).toBe(false)
        expect(l.take("b").allowed).toBe(true)
    })

    it("does not limit anything at a rate of 0", () => {
        clock = 1_000_000
        const l = limiter(0, 1)
        for (let i = 0; i < 1000; i++) expect(l.take("a").allowed).toBe(true)
        expect(l.size).toBe(0)
    })

    it("drops idle keys whose bucket is full again, and keeps those still draining", () => {
        clock = 1_000_000
        const l = limiter(1, 200)
        for (let i = 0; i < 150; i++) l.take("slow")
        l.take("quiet")
        expect(l.size).toBe(2)

        // "quiet" is idle and full again; "slow" is idle but still short at 1/s.
        clock += 61_000
        l.take("other")
        expect(l.size).toBe(2)

        clock += 150_000
        l.take("other")
        expect(l.size).toBe(1)
    })
})
