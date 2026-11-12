import { describe, expect, it } from "bun:test"
import { HumanPassportClaimGate } from "./humanPassportClaimGate"

const claimFor = (address: string): any => ({ address, score: 25, threshold: 20 })

function gate(opts: ConstructorParameters<typeof HumanPassportClaimGate>[1] = {}) {
    let now = 1_000_000
    const fetched: string[] = []
    let fail = false
    const g = new HumanPassportClaimGate(
        async address => {
            fetched.push(address)
            if (fail) throw new Error("provider down")
            return claimFor(address)
        },
        { now: () => now, ...opts },
    )
    return {
        g,
        fetched,
        advance: (ms: number) => {
            now += ms
        },
        failNext: (v: boolean) => {
            fail = v
        },
    }
}

const A = "0x" + "aa".repeat(20)
const B = "0x" + "bb".repeat(20)
const C = "0x" + "cc".repeat(20)

describe("Human Passport claim cache", () => {
    it("serves an address from the cache for 60 s, whatever its case, then fetches again", async () => {
        const t = gate()
        expect(await t.g.get("x", A)).toEqual({ claim: claimFor(A) })
        t.advance(59_999)
        expect(await t.g.get("y", A.toUpperCase().replace("0X", "0x"))).toEqual({ claim: claimFor(A) })
        expect(t.fetched).toEqual([A])
        t.advance(1)
        await t.g.get("x", A)
        expect(t.fetched).toEqual([A, A])
    })

    it("keeps at most maxEntries addresses and drops the least recently used", async () => {
        const t = gate({ maxEntries: 2, burst: 100 })
        await t.g.get("x", A)
        await t.g.get("x", B)
        await t.g.get("x", A)
        await t.g.get("x", C)
        expect(t.g.cachedCount).toBe(2)
        await t.g.get("x", A)
        expect(t.fetched).toEqual([A, B, C])
        await t.g.get("x", B)
        expect(t.fetched).toEqual([A, B, C, B])
    })

    it("does not cache a failed fetch", async () => {
        const t = gate()
        t.failNext(true)
        await expect(t.g.get("x", A)).rejects.toThrow("provider down")
        t.failNext(false)
        expect(await t.g.get("x", A)).toEqual({ claim: claimFor(A) })
        expect(t.fetched).toEqual([A, A])
    })

    it("makes one provider call for concurrent requests of one address", async () => {
        const t = gate()
        const both = await Promise.all([t.g.get("x", A), t.g.get("y", A)])
        expect(both).toEqual([{ claim: claimFor(A) }, { claim: claimFor(A) }])
        expect(t.fetched).toEqual([A])
    })
})

describe("Human Passport claim per-caller limit", () => {
    it("allows a burst of fetches, then refuses with the time until the next token", async () => {
        const t = gate({ burst: 2, ratePerSec: 0.5 })
        expect(await t.g.get("x", A)).toHaveProperty("claim")
        expect(await t.g.get("x", B)).toHaveProperty("claim")
        expect(await t.g.get("x", C)).toEqual({ retryAfterMs: 2_000 })
        expect(t.fetched).toEqual([A, B])
        t.advance(2_000)
        expect(await t.g.get("x", C)).toHaveProperty("claim")
    })

    it("charges provider fetches only: cached answers stay free past the limit", async () => {
        const t = gate({ burst: 1, ratePerSec: 0.1 })
        await t.g.get("x", A)
        for (let i = 0; i < 10; i++) {
            expect(await t.g.get("x", A)).toHaveProperty("claim")
        }
        expect(await t.g.get("x", B)).toHaveProperty("retryAfterMs")
    })

    it("limits each caller on its own", async () => {
        const t = gate({ burst: 1, ratePerSec: 0.1 })
        await t.g.get("x", A)
        expect(await t.g.get("x", B)).toHaveProperty("retryAfterMs")
        expect(await t.g.get("y", B)).toHaveProperty("claim")
    })

    it("tracks a bounded number of callers", async () => {
        const t = gate({ maxCallers: 3, burst: 1 })
        for (let i = 0; i < 10; i++) {
            await t.g.get(`caller-${i}`, "0x" + i.toString(16).padStart(2, "0").repeat(20))
        }
        expect(t.g.trackedCallers).toBe(3)
    })
})
