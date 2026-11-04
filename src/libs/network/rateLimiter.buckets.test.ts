import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"

const authContexts = new WeakMap<Request, unknown>()
mock.module("./authContext", () => ({
    getAuthContext: (req: Request) =>
        authContexts.get(req) ?? {
            verified: false,
            identity: null,
            publicKey: null,
            algorithm: null,
        },
    setAuthContext: (req: Request, ctx: unknown) => {
        authContexts.set(req, ctx)
    },
}))

let peerTable = new Set<string>()
mock.module("@/libs/peer", () => ({
    PeerManager: {
        getInstance: () => ({
            getPeer: (id: string) => (peerTable.has(id) ? { identity: id } : undefined),
        }),
    },
}))

let stakedKeys = new Set<string>()
mock.module("@/libs/consensus/stakedSet", () => ({
    getStakedSet: async () => stakedKeys as ReadonlySet<string>,
}))

mock.module("@/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: { getGCRValidatorsAtBlockOrThrow: async (_height: number) => [] },
}))

let verifyCalls = 0
let signer: string | null = null
mock.module("./verifySignature", () => ({
    verifySignature: async () => {
        verifyCalls++
        return signer
            ? { valid: true, identity: `ed25519:${signer}`, publicKey: signer, algorithm: "ed25519" }
            : { valid: false, error: "bad signature" }
    },
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

    it("counts a GET route outside the path map per minute, not on the daily POST quota", async () => {
        expect((await hit(limiter, "/storage-program/search?q=a")).status).toBe(200)
        expect((await hit(limiter, "/zk/merkle-root")).status).toBe(200)
        expect((await hit(limiter, "/storage-program/search?q=b")).status).toBe(429)

        expect(limiter.getCurrentLimits(IP)).toBeNull()
        expect((await hit(limiter, "/", "POST")).status).toBe(200)
    })

    it("gives unmapped GET routes their own bucket when one is configured", async () => {
        limiter.destroy()
        limiter = makeLimiter({
            blockDurationMs: 60_000,
            methodLimits: {
                POST: { maxRequests: 3, windowMs: DAY },
                GET: { maxRequests: 1, windowMs: 60_000 },
            },
        })
        expect((await hit(limiter, "/zk/merkle-root")).status).toBe(200)
        expect((await hit(limiter, "/zk/merkle-root")).status).toBe(429)
        // The mapped routes keep the default bucket.
        expect((await hit(limiter, "/info")).status).toBe(200)
        expect([...limiter.ipRequests.keys()].sort()).toEqual([`GET|${IP}`, `default|${IP}`])
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

describe("RateLimiter failed signature checks", () => {
    let limiter: InstanceType<typeof RateLimiter>

    const signed = (from = IP) => {
        const peer = { requestIP: () => ({ address: from }) } as never
        const req = new Request("http://node/", {
            method: "POST",
            headers: { identity: "ed25519:0xabc", signature: "0xdead", timestamp: "1" },
        })
        return limiter.createMiddleware()(req, ok, peer)
    }

    beforeEach(() => {
        now = 1_000_000
        verifyCalls = 0
        spyOn(Date, "now").mockImplementation(() => now)
        limiter = makeLimiter({ blockDurationMs: 60_000 })
    })

    afterEach(() => {
        limiter.destroy()
        mock.restore()
    })

    it("counts each failed check and blocks the source past the limit", async () => {
        expect((await signed()).status).toBe(401)
        expect((await signed()).status).toBe(401)
        expect((await signed()).status).toBe(429)
        expect(verifyCalls).toBe(3)
    })

    it("refuses a blocked source before verifying again", async () => {
        await signed()
        await signed()
        await signed()
        const blocked = await signed()
        expect(blocked.status).toBe(429)
        expect(blocked.headers.get("Retry-After")).toBe("60")
        expect(verifyCalls).toBe(3)
    })

    it("keeps failed checks off the request quotas of the same source", async () => {
        await signed()
        await signed()
        expect((await hit(limiter, "/info")).status).toBe(200)
        expect(limiter.getCurrentLimits(IP)).toBeNull()
    })

    it("does not count failed checks from a whitelisted address", async () => {
        limiter.destroy()
        limiter = makeLimiter({ blockDurationMs: 60_000, whitelistedIPs: [IP] })
        for (let i = 0; i < 5; i++) expect((await signed()).status).toBe(401)
    })
})

describe("RateLimiter signed requests", () => {
    let limiter: InstanceType<typeof RateLimiter>

    const signedBy = (key: string) => {
        signer = key
        const req = new Request("http://node/info", {
            headers: { identity: `ed25519:${key}`, signature: "0xsig", timestamp: "1" },
        })
        return limiter.createMiddleware()(req, ok, server)
    }

    beforeEach(() => {
        now = 1_000_000
        spyOn(Date, "now").mockImplementation(() => now)
        limiter = makeLimiter({ blockDurationMs: 60_000 })
        stakedKeys = new Set(["0xbeef"])
        peerTable = new Set(["0xpeer"])
    })

    afterEach(() => {
        signer = null
        stakedKeys = new Set()
        peerTable = new Set()
        limiter.destroy()
        mock.restore()
    })

    it("limits a key that is only in the peer table", async () => {
        expect((await signedBy("0xpeer")).status).toBe(200)
        expect((await signedBy("0xpeer")).status).toBe(200)
        expect((await signedBy("0xpeer")).status).toBe(429)
    })

    it("lets a staked validator through", async () => {
        for (let i = 0; i < 5; i++) expect((await signedBy("0xbeef")).status).toBe(200)
    })

    // A bad signature claiming `key`, as a POST to the RPC root.
    const forged = (key: string) => {
        signer = null
        const req = new Request("http://node/", {
            method: "POST",
            headers: { identity: `ed25519:${key}`, signature: "0xforged", timestamp: "1" },
        })
        return limiter.createMiddleware()(req, ok, server)
    }

    it("lets a staked validator through from an address whose failure bucket is exhausted", async () => {
        // Proxy or NAT: other clients share the validator's address.
        expect((await forged("0xabc")).status).toBe(401)
        expect((await forged("0xabc")).status).toBe(401)
        expect((await forged("0xabc")).status).toBe(429)

        expect((await signedBy("0xbeef")).status).toBe(200)

        verifyCalls = 0
        expect((await forged("0xabc")).status).toBe(429)
        expect(verifyCalls).toBe(0)
    })

    it("counts a forged validator claim on the request quota, not the failure bucket", async () => {
        for (let i = 0; i < 3; i++) expect((await forged("0xBEEF")).status).toBe(401)
        expect((await forged("0xbeef")).status).toBe(429)
        expect([...limiter.ipRequests.keys()]).toEqual([`POST|${IP}`])

        // The real validator never draws on that quota.
        expect((await signedBy("0xbeef")).status).toBe(200)
    })
})
