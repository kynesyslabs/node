/**
 * The web2 proxy fetches on behalf of anyone who asks, unsigned and free, so
 * the node caps each caller's running fetches, fetch rate and response bytes,
 * and every caller's running fetches together. A slot must come back however
 * the fetch ends, and the table of callers must stay bounded.
 */

import { beforeEach, describe, expect, it, jest, mock } from "bun:test"

const quietLog = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
    only: jest.fn(),
}
mock.module("src/utilities/logger", () => ({ __esModule: true, default: quietLog }))
mock.module("@/utilities/logger", () => ({ __esModule: true, default: quietLog }))

const { Web2FetchLimiter, web2CallerForAddress } = await import("./web2FetchLimiter")
const { Config } = await import("src/config")

const MIB = 1024 * 1024
let now = 1_000_000

function limiter(overrides: Record<string, number> = {}) {
    return new Web2FetchLimiter({
        maxInflightPerCaller: 2,
        maxFetchesPerMinutePerCaller: 10,
        maxBytesPerHourPerCaller: 100 * MIB,
        maxInflightTotal: 32,
        now: () => now,
        ...overrides,
    })
}

const A = { key: "ip:203.0.113.1" }
const B = { key: "ip:203.0.113.2" }

beforeEach(() => {
    now = 1_000_000
    quietLog.warning.mockClear()
})

describe("per-caller in-flight cap", () => {
    it("refuses a caller's third concurrent fetch until one ends", () => {
        const l = limiter()
        const first = l.acquire(A).lease
        const second = l.acquire(A).lease
        expect(first).not.toBeNull()
        expect(second).not.toBeNull()

        const third = l.acquire(A)
        expect(third.lease).toBeNull()
        expect(third.refusal).toMatchObject({ reason: "caller-inflight", retryAfterSeconds: 1 })
        expect(third.refusal.message).toContain("2 web2 fetches in flight")

        // Another caller is not affected.
        expect(l.acquire(B).lease).not.toBeNull()

        first.release(0)
        expect(l.acquire(A).lease).not.toBeNull()
    })

    it("counts a lease released twice only once", () => {
        const l = limiter()
        const a = l.acquire(A).lease
        const b = l.acquire(A).lease
        a.release()
        a.release()
        expect(l.stats().inflightTotal).toBe(1)
        // b is still running, so only one more fits.
        expect(l.acquire(A).lease).not.toBeNull()
        expect(l.acquire(A).refusal?.reason).toBe("caller-inflight")
        b.release()
    })
})

describe("per-caller fetch rate", () => {
    it("allows 10 fetches in a minute, refuses the 11th, then refills", () => {
        const l = limiter()
        for (let i = 0; i < 10; i++) {
            const { lease } = l.acquire(A)
            expect(lease).not.toBeNull()
            lease.release(0)
        }
        const eleventh = l.acquire(A)
        expect(eleventh.refusal?.reason).toBe("caller-rate")
        // One token comes back every 6 s.
        expect(eleventh.refusal.retryAfterSeconds).toBe(6)
        expect(l.acquire(B).lease).not.toBeNull()

        now += 6_000
        const after = l.acquire(A)
        expect(after.lease).not.toBeNull()
        after.lease.release(0)
        expect(l.acquire(A).refusal?.reason).toBe("caller-rate")
    })

    it("does not spend a token on a refused attempt", () => {
        const l = limiter({ maxFetchesPerMinutePerCaller: 3 })
        const held = [l.acquire(A).lease, l.acquire(A).lease]
        // Refused for concurrency, many times over.
        for (let i = 0; i < 20; i++) expect(l.acquire(A).lease).toBeNull()
        for (const h of held) h.release(0)
        expect(l.acquire(A).lease).not.toBeNull()
    })
})

describe("per-caller byte budget", () => {
    it("charges the bytes read and refuses the next fetch once the budget is spent", () => {
        const l = limiter()
        for (let i = 0; i < 10; i++) {
            const { lease } = l.acquire(A)
            expect(lease).not.toBeNull()
            lease.release(11 * MIB)
            // Stay under the fetch rate: this test is about bytes.
            now += 6_000
        }
        const refused = l.acquire(A)
        expect(refused.refusal?.reason).toBe("caller-bytes")
        expect(refused.refusal.retryAfterSeconds).toBeGreaterThan(0)
        expect(l.acquire(B).lease).not.toBeNull()

        // The budget refills over the hour.
        now += refused.refusal.retryAfterSeconds * 1000
        expect(l.acquire(A).lease).not.toBeNull()
    })

    it("lets the fetch that crosses the budget finish but refuses the next one", () => {
        const l = limiter({ maxBytesPerHourPerCaller: 5 * MIB })
        const { lease } = l.acquire(A)
        lease.release(10 * MIB)
        const next = l.acquire(A)
        expect(next.refusal?.reason).toBe("caller-bytes")
        // 5 MIB over a 5 MIB/hour budget: about an hour to pay back.
        expect(next.refusal.retryAfterSeconds).toBeGreaterThanOrEqual(3600)
    })
})

describe("node-wide in-flight cap", () => {
    it("refuses once every slot is taken, across callers, and frees on release", () => {
        const l = limiter({ maxInflightTotal: 3 })
        const leases = [
            l.acquire({ key: "ip:a" }).lease,
            l.acquire({ key: "ip:b" }).lease,
            l.acquire({ key: "ip:c" }).lease,
        ]
        const refused = l.acquire({ key: "ip:d" })
        expect(refused.refusal?.reason).toBe("node-inflight")
        leases[0].release()
        expect(l.acquire({ key: "ip:d" }).lease).not.toBeNull()
    })

    it("lets an exempt caller skip its own limits but not the node-wide cap", () => {
        const l = limiter({ maxInflightTotal: 4 })
        const local = { key: "ip:127.0.0.1", exempt: true }
        const held = [1, 2, 3, 4].map(() => l.acquire(local).lease)
        expect(held.every(h => h !== null)).toBe(true)
        expect(l.acquire(local).refusal?.reason).toBe("node-inflight")
        expect(l.acquire(A).refusal?.reason).toBe("node-inflight")
        for (const h of held) h.release()
        for (let i = 0; i < 30; i++) l.acquire(local).lease.release(50 * MIB)
        expect(l.acquire(local).lease).not.toBeNull()
    })

    it("counts a fetch with no caller against the node-wide cap only", () => {
        const l = limiter({ maxInflightTotal: 3 })
        const held = [1, 2, 3].map(() => l.acquire().lease)
        expect(held.every(h => h !== null)).toBe(true)
        expect(l.acquire().refusal?.reason).toBe("node-inflight")
        expect(l.stats().trackedCallers).toBe(0)
    })

    it("does not take a caller's slot or token when the node is full", () => {
        const l = limiter({ maxInflightTotal: 1, maxFetchesPerMinutePerCaller: 1 })
        const held = l.acquire(B).lease
        expect(l.acquire(A).refusal?.reason).toBe("node-inflight")
        held.release()
        expect(l.acquire(A).lease).not.toBeNull()
    })
})

describe("release on every exit", () => {
    it("frees the slot when the fetch throws or times out", async () => {
        const l = limiter({ maxInflightTotal: 1 })
        const fetchWith = async (fn: () => Promise<number>) => {
            const { lease } = l.acquire(A)
            if (!lease) throw new Error("refused")
            let bytes = 0
            try {
                bytes = await fn()
            } finally {
                lease.release(bytes)
            }
        }
        await expect(fetchWith(async () => { throw new Error("origin reset") })).rejects.toThrow("origin reset")
        expect(l.stats().inflightTotal).toBe(0)
        await expect(
            fetchWith(
                () =>
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error("Web2 request did not complete within 20 ms")), 20),
                    ),
            ),
        ).rejects.toThrow("did not complete")
        expect(l.stats().inflightTotal).toBe(0)
        expect(l.acquire(A).lease).not.toBeNull()
    })

    it("frees a slot held past the hold limit, and still charges its bytes later", async () => {
        const l = limiter({ maxInflightTotal: 1, holdLimitMs: 20, maxBytesPerHourPerCaller: MIB })
        const hung = l.acquire(A).lease
        expect(l.acquire(B).refusal?.reason).toBe("node-inflight")
        await new Promise(r => setTimeout(r, 60))
        expect(l.stats().inflightTotal).toBe(0)
        expect(quietLog.warning).toHaveBeenCalled()

        const next = l.acquire(B).lease
        expect(next).not.toBeNull()
        // The late release frees nothing twice and still charges the caller.
        hung.release(2 * MIB)
        expect(l.stats().inflightTotal).toBe(1)
        expect(l.acquire(A).refusal?.reason).toBe("caller-bytes")
        next.release()
    })
})

describe("bounded caller table", () => {
    it("never tracks more callers than its cap, dropping the least recently seen", () => {
        const l = limiter({ maxTrackedCallers: 100 })
        for (let i = 0; i < 1_000; i++) {
            l.acquire({ key: `ip:10.0.${i >> 8}.${i & 255}` }).lease.release()
        }
        expect(l.stats().trackedCallers).toBe(100)
        expect(l.stats().evictions).toBe(900)
    })

    it("keeps a caller with a fetch in flight", () => {
        const l = limiter({ maxTrackedCallers: 3 })
        const held = [l.acquire(A).lease, l.acquire(A).lease]
        for (let i = 0; i < 50; i++) l.acquire({ key: `ip:x${i}` }).lease.release()
        // A is still at its in-flight cap: its entry was not dropped.
        expect(l.acquire(A).refusal?.reason).toBe("caller-inflight")
        for (const h of held) h.release()
    })

    it("drops idle callers once they are fully refilled", () => {
        const l = limiter({ sweepIntervalMs: 60_000 })
        for (let i = 0; i < 50; i++) l.acquire({ key: `ip:y${i}` }).lease.release(MIB)
        const held = l.acquire(A).lease
        expect(l.stats().trackedCallers).toBe(51)

        // By the next sweep a minute later their token and their 1 MIB have
        // both come back.
        now += 60_000
        l.acquire(B).lease.release()
        // Only A (in flight) and B (just used) remain.
        expect(l.stats().trackedCallers).toBe(2)
        held.release()
    })
})

describe("refusal log", () => {
    it("writes at most one line per interval under a flood", () => {
        const l = limiter({ maxInflightTotal: 1, refusalLogIntervalMs: 10_000 })
        const held = l.acquire(A).lease
        for (let i = 0; i < 5_000; i++) l.acquire({ key: `ip:f${i % 300}` })
        expect(quietLog.warning).toHaveBeenCalledTimes(1)
        now += 10_000
        l.acquire(B)
        expect(quietLog.warning).toHaveBeenCalledTimes(2)
        expect(String(quietLog.warning.mock.calls[1][0])).toContain("node-inflight=")
        held.release()
    })
})

describe("caller keys and configuration", () => {
    it("keys a tx sender by its lower-case address without 0x", () => {
        expect(web2CallerForAddress("0xAbC")).toEqual({ key: "addr:abc" })
        expect(web2CallerForAddress("abc")).toEqual({ key: "addr:abc" })
        expect(web2CallerForAddress(undefined)).toEqual({ key: "addr:unknown" })
    })

    it("refuses a non-positive limit", () => {
        expect(() => limiter({ maxInflightTotal: 0 })).toThrow(/maxInflightTotal/)
        expect(() => limiter({ maxInflightPerCaller: 1.5 })).toThrow(/maxInflightPerCaller/)
    })

    it("builds the node's limiter from the outbound config", () => {
        process.env.WEB2_MAX_INFLIGHT_TOTAL = "1"
        Config.resetInstance()
        Web2FetchLimiter.resetInstance()
        try {
            const l = Web2FetchLimiter.instance
            expect(Web2FetchLimiter.instance).toBe(l)
            const held = l.acquire(A).lease
            expect(l.acquire(B).refusal?.reason).toBe("node-inflight")
            held.release()
        } finally {
            delete process.env.WEB2_MAX_INFLIGHT_TOTAL
            Config.resetInstance()
            Web2FetchLimiter.resetInstance()
        }
    })
})
