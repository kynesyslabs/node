import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"

mock.module("./authContext", () => ({
    getAuthContext: () => ({
        verified: false,
        identity: null,
        publicKey: null,
        algorithm: null,
    }),
    setAuthContext: () => undefined,
}))

mock.module("@/libs/peer", () => ({
    PeerManager: { getInstance: () => ({ getPeer: () => undefined }) },
}))

mock.module("./verifySignature", () => ({
    verifySignature: async () => ({ valid: false, error: "unused" }),
    isKeyWhitelisted: () => false,
}))

mock.module("@/forks", () => ({ isForkActive: () => false }))

mock.module("@kynesyslabs/demosdk/encryption", () => ({
    uint8ArrayToHex: (value: Uint8Array) => Buffer.from(value).toString("hex"),
}))

mock.module("@/utilities/sharedState", () => ({
    getSharedState: { keypair: null, lastBlockNumber: 7 },
}))

const { RateLimiter } = await import("./middleware/rateLimiter")
const { handleIdentityTxRateLimit } = await import("./rpcRateLimit")

const IP = "203.0.113.9"
const server = { requestIP: () => ({ address: IP }) } as never
const ok = async () => new Response("ok")

const DAY = 86_400_000
let now = 1_000_000

function makeLimiter(overrides: Record<string, unknown> = {}) {
    return new RateLimiter({
        enabled: true,
        defaultLimit: { maxRequests: 2, windowMs: 1_000 },
        blockDurationMs: undefined as unknown as number,
        whitelistedIPs: [],
        whitelistedKeys: [],
        methodLimits: { POST: { maxRequests: 3, windowMs: DAY } },
        txPerBlock: 4,
        ...overrides,
    })
}

function hit(
    limiter: InstanceType<typeof RateLimiter>,
    path: string,
    method = "GET",
    from = IP,
) {
    const mw = limiter.createMiddleware()
    const peer = { requestIP: () => ({ address: from }) } as never
    return mw(new Request(`http://node${path}`, { method }), ok, from === IP ? server : peer)
}

describe("RateLimiter blocking", () => {
    let limiter: InstanceType<typeof RateLimiter>

    beforeEach(() => {
        now = 1_000_000
        spyOn(Date, "now").mockImplementation(() => now)
        limiter = makeLimiter()
    })

    afterEach(() => {
        limiter.destroy()
        mock.restore()
    })

    it("holds a block with a real expiry and a numeric Retry-After when no duration is configured", async () => {
        expect((await hit(limiter, "/info")).status).toBe(200)
        expect((await hit(limiter, "/info")).status).toBe(200)

        const tripped = await hit(limiter, "/info")
        expect(tripped.status).toBe(429)
        expect(tripped.headers.get("Retry-After")).toBe("60")

        now += 10_000
        const stillBlocked = await hit(limiter, "/info")
        expect(stillBlocked.status).toBe(429)
        expect(stillBlocked.headers.get("Retry-After")).toBe("50")
        expect(Number.isNaN(Number(stillBlocked.headers.get("Retry-After")))).toBe(false)
    })

    it("starts a fresh window when the block runs out instead of re-blocking on the stale count", async () => {
        limiter.destroy()
        limiter = makeLimiter({ blockDurationMs: 5_000 })
        await hit(limiter, "/info")
        await hit(limiter, "/info")
        expect((await hit(limiter, "/info")).status).toBe(429)

        now += 5_001
        expect((await hit(limiter, "/info")).status).toBe(200)
        expect((await hit(limiter, "/info")).status).toBe(200)
        expect((await hit(limiter, "/info")).status).toBe(429)
    })

    it("lifts the block for the IP across every bucket on unblock", async () => {
        await hit(limiter, "/info")
        await hit(limiter, "/info")
        await hit(limiter, "/info")
        expect(limiter.getStats().blockedIPs).toBe(1)

        expect(limiter.unblockIP([IP, "198.51.100.1"])).toEqual({
            [IP]: true,
            "198.51.100.1": false,
        })
        expect((await hit(limiter, "/info")).status).toBe(200)
    })
})

describe("RateLimiter per-bucket counters", () => {
    let limiter: InstanceType<typeof RateLimiter>

    beforeEach(() => {
        now = 1_000_000
        spyOn(Date, "now").mockImplementation(() => now)
        limiter = makeLimiter({ blockDurationMs: 60_000 })
    })

    afterEach(() => {
        limiter.destroy()
        mock.restore()
    })

    it("does not let a short-window route reset the long-window POST counter", async () => {
        await hit(limiter, "/", "POST")
        await hit(limiter, "/", "POST")
        await hit(limiter, "/", "POST")

        // The default window (1 s) lapses; a GET inside the new window used to
        // zero the one counter every route shared, handing POST a fresh quota.
        now += 2_000
        expect((await hit(limiter, "/info")).status).toBe(200)

        expect((await hit(limiter, "/", "POST")).status).toBe(429)
    })

    it("keeps one counter per bucket, so GET traffic does not spend the POST quota", async () => {
        await hit(limiter, "/info")
        await hit(limiter, "/info")

        expect((await hit(limiter, "/", "POST")).status).toBe(200)
        expect(limiter.getCurrentLimits(IP)).toMatchObject({ limit: 3, remaining: 2 })
    })

    it("shares one counter between routes that have no limit of their own", async () => {
        await hit(limiter, "/info")
        await hit(limiter, "/genesis")
        expect((await hit(limiter, "/peerlist")).status).toBe(429)
    })

    it("cleanup drops an entry only once its own window has passed", async () => {
        await hit(limiter, "/info")
        await hit(limiter, "/", "POST")
        expect(limiter.ipRequests.size).toBe(2)

        // Well past the 1 s default window, far inside the 24 h POST window.
        now += 60 * 60 * 1000
        ;(limiter as unknown as { cleanup(): void }).cleanup()
        expect([...limiter.ipRequests.keys()]).toEqual([`POST|${IP}`])
        expect(limiter.getCurrentLimits(IP)).toMatchObject({ remaining: 2 })

        now += DAY
        ;(limiter as unknown as { cleanup(): void }).cleanup()
        expect(limiter.ipRequests.size).toBe(0)
    })

    it("cleanup keeps a live block and drops an elapsed one", async () => {
        await hit(limiter, "/info")
        await hit(limiter, "/info")
        await hit(limiter, "/info")

        now += 30_000
        ;(limiter as unknown as { cleanup(): void }).cleanup()
        expect(limiter.ipRequests.size).toBe(1)

        now += 31_000
        ;(limiter as unknown as { cleanup(): void }).cleanup()
        expect(limiter.ipRequests.size).toBe(0)
    })

    it("counts identity-tx volume on the POST counter", async () => {
        const req = new Request("http://node/", { method: "POST" })
        const noEntry = handleIdentityTxRateLimit(
            req,
            IP,
            { method: "ping", params: [] } as never,
            limiter,
        )
        expect(noEntry?.status).toBe(400)

        await hit(limiter, "/", "POST")
        const passes = handleIdentityTxRateLimit(
            req,
            IP,
            { method: "ping", params: [] } as never,
            limiter,
        )
        expect(passes).toBeNull()
    })
})

describe("RateLimiter long-window cap through a block", () => {
    let limiter: InstanceType<typeof RateLimiter>

    beforeEach(() => {
        now = 1_000_000
        spyOn(Date, "now").mockImplementation(() => now)
        limiter = makeLimiter({ blockDurationMs: 60_000 })
    })

    afterEach(() => {
        limiter.destroy()
        mock.restore()
    })

    it("keeps the daily POST count when the block ends, and clears it only when the window does", async () => {
        for (let i = 0; i < 3; i++) await hit(limiter, "/", "POST")
        expect((await hit(limiter, "/", "POST")).status).toBe(429)

        now += 61_000
        expect((await hit(limiter, "/", "POST")).status).toBe(429)
        now += 61_000
        expect((await hit(limiter, "/", "POST")).status).toBe(429)

        now += DAY
        expect((await hit(limiter, "/", "POST")).status).toBe(200)
    })

    it("cleanup keeps a counter whose block ended but whose window has not", async () => {
        for (let i = 0; i < 4; i++) await hit(limiter, "/", "POST")
        now += 61_000
        ;(limiter as unknown as { cleanup(): void }).cleanup()
        expect(limiter.ipRequests.size).toBe(1)

        now += DAY
        ;(limiter as unknown as { cleanup(): void }).cleanup()
        expect(limiter.ipRequests.size).toBe(0)
    })
})

describe("RateLimiter IPv6 subjects", () => {
    let limiter: InstanceType<typeof RateLimiter>

    beforeEach(() => {
        now = 1_000_000
        spyOn(Date, "now").mockImplementation(() => now)
        limiter = makeLimiter({ blockDurationMs: 60_000 })
    })

    afterEach(() => {
        limiter.destroy()
        mock.restore()
    })

    it("counts every address in a /64 as one client", async () => {
        await hit(limiter, "/info", "GET", "2001:db8:1:2::1")
        await hit(limiter, "/info", "GET", "2001:db8:1:2:aaaa:bbbb:cccc:dddd")
        const third = await hit(limiter, "/info", "GET", "2001:db8:1:2:ffff::9")
        expect(third.status).toBe(429)
        expect([...limiter.ipRequests.keys()]).toEqual(["default|2001:db8:1:2::/64"])
    })

    it("keeps different /64s apart", async () => {
        await hit(limiter, "/info", "GET", "2001:db8:1:2::1")
        await hit(limiter, "/info", "GET", "2001:db8:1:2::2")
        expect((await hit(limiter, "/info", "GET", "2001:db8:1:3::1")).status).toBe(200)
        expect(limiter.ipRequests.size).toBe(2)
    })

    it("leaves IPv4, including IPv4-mapped IPv6, as the plain address", async () => {
        await hit(limiter, "/info", "GET", "::ffff:198.51.100.7")
        await hit(limiter, "/info", "GET", "198.51.100.7")
        expect([...limiter.ipRequests.keys()]).toEqual(["default|198.51.100.7"])
    })

    it("unblocks a whole /64 when asked about one address in it", async () => {
        for (let i = 0; i < 3; i++) await hit(limiter, "/info", "GET", `2001:db8:1:2::${i + 1}`)
        expect(limiter.unblockIP(["2001:db8:1:2::77"])).toEqual({ "2001:db8:1:2::77": true })
        expect((await hit(limiter, "/info", "GET", "2001:db8:1:2::5")).status).toBe(200)
    })
})

describe("RateLimiter tracked counter cap", () => {
    let limiter: InstanceType<typeof RateLimiter>

    beforeEach(() => {
        now = 1_000_000
        spyOn(Date, "now").mockImplementation(() => now)
        limiter = makeLimiter({ blockDurationMs: 60_000, maxTrackedCounters: 10 })
    })

    afterEach(() => {
        limiter.destroy()
        mock.restore()
    })

    it("stays at the cap by dropping the counters with the oldest window start", async () => {
        for (let i = 1; i <= 25; i++) {
            now += 10
            await hit(limiter, "/info", "GET", `198.51.100.${i}`)
        }
        expect(limiter.ipRequests.size).toBeLessThanOrEqual(10)
        expect(limiter.ipRequests.has("default|198.51.100.25")).toBe(true)
        expect(limiter.ipRequests.has("default|198.51.100.1")).toBe(false)
    })

    it("drops live blocks last, so a flood cannot wash its own block away", async () => {
        const blocked = "203.0.113.200"
        for (let i = 0; i < 3; i++) await hit(limiter, "/info", "GET", blocked)
        expect((await hit(limiter, "/info", "GET", blocked)).status).toBe(429)

        for (let i = 1; i <= 25; i++) {
            now += 10
            await hit(limiter, "/info", "GET", `198.51.100.${i}`)
        }
        expect(limiter.ipRequests.size).toBeLessThanOrEqual(10)
        expect((await hit(limiter, "/info", "GET", blocked)).status).toBe(429)
    })
})
