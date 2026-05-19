import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"

const mockGetAuthContext = mock(() => ({
    verified: false,
    identity: null,
    publicKey: null,
    algorithm: null,
}))
const mockGetPeer = mock(() => undefined)

mock.module("./authContext", () => ({
    getAuthContext: () => mockGetAuthContext(),
    setAuthContext: mock(() => undefined),
}))

mock.module("@/libs/peer", () => ({
    PeerManager: {
        getInstance: () => ({
            getPeer: () => mockGetPeer(),
        }),
    },
}))

mock.module("@kynesyslabs/demosdk/encryption", () => ({
    uint8ArrayToHex: (value: Uint8Array) => Buffer.from(value).toString("hex"),
    hexToUint8Array: (value: string) =>
        Uint8Array.from(Buffer.from(value, "hex")),
    ucrypto: {
        verify: async () => true,
    },
}))

mock.module("@/utilities/sharedState", () => ({
    getSharedState: {
        keypair: {
            publicKey: Uint8Array.from([0xaa, 0xbb, 0xcc]),
        },
    },
}))

const rateLimiterModule = await import("./middleware/rateLimiter")

describe("RateLimiter trusted internal requests", () => {
    let rateLimiter: InstanceType<typeof rateLimiterModule.RateLimiter>

    beforeEach(() => {
        mockGetAuthContext.mockImplementation(() => ({
            verified: false,
            identity: null,
            publicKey: null,
            algorithm: null,
        }))
        mockGetPeer.mockImplementation(() => undefined)

        rateLimiter = new rateLimiterModule.RateLimiter({
            enabled: true,
            defaultLimit: {
                maxRequests: 10,
                windowMs: 1000,
            },
            blockDurationMs: 1000,
            whitelistedIPs: ["127.0.0.1"],
            whitelistedKeys: [],
            methodLimits: {},
            txPerBlock: 4,
        })
    })

    afterEach(() => {
        rateLimiter.destroy()
        mockGetAuthContext.mockClear()
        mockGetPeer.mockClear()
    })

    it("trusts authenticated known peers", () => {
        mockGetAuthContext.mockImplementation(() => ({
            verified: true,
            identity: "ed25519:peer-key",
            publicKey: "peer-key",
            algorithm: "ed25519",
        }))
        mockGetPeer.mockImplementation(() => ({ identity: "peer-key" }))

        const trusted = rateLimiter.isTrustedInternalRequest(
            new Request("http://localhost/"),
            "172.25.0.4",
        )

        expect(trusted).toBe(true)
        expect(mockGetPeer).toHaveBeenCalledWith("peer-key")
    })

    it("trusts the local node identity", () => {
        mockGetAuthContext.mockImplementation(() => ({
            verified: true,
            identity: "ed25519:aabbcc",
            publicKey: "aabbcc",
            algorithm: "ed25519",
        }))

        const trusted = rateLimiter.isTrustedInternalRequest(
            new Request("http://localhost/"),
            "172.25.0.4",
        )

        expect(trusted).toBe(true)
        expect(mockGetPeer).not.toHaveBeenCalled()
    })

    it("does not trust unknown authenticated callers", () => {
        mockGetAuthContext.mockImplementation(() => ({
            verified: true,
            identity: "ed25519:unknown-key",
            publicKey: "unknown-key",
            algorithm: "ed25519",
        }))

        const trusted = rateLimiter.isTrustedInternalRequest(
            new Request("http://localhost/"),
            "172.25.0.99",
        )

        expect(trusted).toBe(false)
        expect(mockGetPeer).toHaveBeenCalledWith("unknown-key")
    })
})

// --- XFF spoof-fix coverage (Epic 14 T1) -----------------------------------
//
// Each block constructs a fresh RateLimiter with explicit xffMode +
// trustedProxies in the constructor config so the tests are deterministic
// independent of process.env at run time. The Server stub returns whatever
// socketIp the test passes in.

interface BuildOpts {
    xffMode?: "off" | "strict" | "legacy"
    trustedProxies?: string[]
    whitelistedIPs?: string[]
}

function buildLimiter(opts: BuildOpts = {}) {
    return new rateLimiterModule.RateLimiter({
        enabled: true,
        defaultLimit: { maxRequests: 10, windowMs: 1000 },
        blockDurationMs: 1000,
        whitelistedIPs: opts.whitelistedIPs ?? ["127.0.0.1"],
        whitelistedKeys: [],
        methodLimits: {},
        txPerBlock: 4,
        xffMode: opts.xffMode,
        trustedProxies: opts.trustedProxies,
    })
}

function fakeServer(socketIp: string | null) {
    return {
        requestIP: () => (socketIp ? { address: socketIp, port: 0 } : null),
    } as unknown as Parameters<
        InstanceType<typeof rateLimiterModule.RateLimiter>["getClientIP"]
    >[1]
}

function reqWith(headers: Record<string, string>): Request {
    return new Request("http://localhost/", { headers })
}

describe("RateLimiter getClientIP — off mode (default)", () => {
    it("returns socket IP and ignores XFF", () => {
        const limiter = buildLimiter({ xffMode: "off" })
        const ip = limiter.getClientIP(
            reqWith({ "x-forwarded-for": "1.2.3.4" }),
            fakeServer("172.20.0.5"),
        )
        expect(ip).toBe("172.20.0.5")
        limiter.destroy()
    })

    it("returns socket IP when XFF + X-Real-IP both present", () => {
        const limiter = buildLimiter({ xffMode: "off" })
        const ip = limiter.getClientIP(
            reqWith({
                "x-forwarded-for": "8.8.8.8",
                "x-real-ip": "9.9.9.9",
            }),
            fakeServer("172.20.0.5"),
        )
        expect(ip).toBe("172.20.0.5")
        limiter.destroy()
    })

    it("getXffMode reports 'off' when no list configured", () => {
        const limiter = buildLimiter()
        expect(limiter.getXffMode()).toBe("off")
        expect(limiter.getTrustedProxyCount()).toBe(0)
        limiter.destroy()
    })
})

describe("RateLimiter getClientIP — strict mode", () => {
    it("auto-selects strict when TRUSTED_PROXIES is non-empty", () => {
        const limiter = buildLimiter({ trustedProxies: ["10.0.0.0/8"] })
        expect(limiter.getXffMode()).toBe("strict")
        expect(limiter.getTrustedProxyCount()).toBe(1)
        limiter.destroy()
    })

    it("returns XFF first IP when socket is in trusted CIDR", () => {
        const limiter = buildLimiter({
            xffMode: "strict",
            trustedProxies: ["10.0.0.0/8"],
        })
        const ip = limiter.getClientIP(
            reqWith({ "x-forwarded-for": "8.8.8.8,10.0.0.5" }),
            fakeServer("10.0.0.5"),
        )
        expect(ip).toBe("8.8.8.8")
        limiter.destroy()
    })

    it("falls back to socket IP when socket is NOT trusted", () => {
        const limiter = buildLimiter({
            xffMode: "strict",
            trustedProxies: ["10.0.0.0/8"],
        })
        const ip = limiter.getClientIP(
            reqWith({ "x-forwarded-for": "8.8.8.8" }),
            fakeServer("1.2.3.4"),
        )
        expect(ip).toBe("1.2.3.4")
        limiter.destroy()
    })

    it("collapses chain of trusted hops to left-most non-trusted", () => {
        const limiter = buildLimiter({
            xffMode: "strict",
            trustedProxies: ["10.0.0.0/8", "172.16.0.0/12"],
        })
        const ip = limiter.getClientIP(
            reqWith({
                "x-forwarded-for": "203.0.113.7,10.0.0.5,172.16.0.9",
            }),
            fakeServer("172.16.0.9"),
        )
        expect(ip).toBe("203.0.113.7")
        limiter.destroy()
    })

    it("treats CIDR boundary correctly (172.16.0.0/12 covers 172.31.x but not 172.32.x)", () => {
        const limiter = buildLimiter({
            xffMode: "strict",
            trustedProxies: ["172.16.0.0/12"],
        })
        const inside = limiter.getClientIP(
            reqWith({ "x-forwarded-for": "8.8.8.8" }),
            fakeServer("172.31.255.255"),
        )
        expect(inside).toBe("8.8.8.8")

        const outside = limiter.getClientIP(
            reqWith({ "x-forwarded-for": "8.8.8.8" }),
            fakeServer("172.32.0.0"),
        )
        expect(outside).toBe("172.32.0.0")
        limiter.destroy()
    })

    it("returns socket IP when no XFF but trusted, falls back to X-Real-IP", () => {
        const limiter = buildLimiter({
            xffMode: "strict",
            trustedProxies: ["10.0.0.0/8"],
        })
        const ip = limiter.getClientIP(
            reqWith({ "x-real-ip": "1.1.1.1" }),
            fakeServer("10.0.0.5"),
        )
        expect(ip).toBe("1.1.1.1")
        limiter.destroy()
    })
})

describe("RateLimiter getClientIP — legacy mode", () => {
    it("trusts XFF first IP regardless of socket", () => {
        const limiter = buildLimiter({ xffMode: "legacy" })
        const ip = limiter.getClientIP(
            reqWith({ "x-forwarded-for": "8.8.8.8" }),
            fakeServer("1.2.3.4"),
        )
        expect(ip).toBe("8.8.8.8")
        limiter.destroy()
    })

    it("explicit XFF_MODE=legacy survives even with TRUSTED_PROXIES set", () => {
        const limiter = buildLimiter({
            xffMode: "legacy",
            trustedProxies: ["10.0.0.0/8"],
        })
        expect(limiter.getXffMode()).toBe("legacy")
        limiter.destroy()
    })
})

describe("RateLimiter getClientIP — IP normalisation", () => {
    it("IPv4-mapped IPv6 collapses to plain IPv4", () => {
        const limiter = buildLimiter({ xffMode: "off" })
        const a = limiter.getClientIP(
            reqWith({}),
            fakeServer("::ffff:192.168.1.1"),
        )
        const b = limiter.getClientIP(reqWith({}), fakeServer("192.168.1.1"))
        expect(a).toBe(b)
        expect(a).toBe("192.168.1.1")
        limiter.destroy()
    })

    it("bracketed IPv6 with port strips both", () => {
        const limiter = buildLimiter({ xffMode: "off" })
        const ip = limiter.getClientIP(reqWith({}), fakeServer("[::1]:443"))
        expect(ip).toBe("::1")
        limiter.destroy()
    })

    it("IPv4 with embedded port strips the port", () => {
        const limiter = buildLimiter({ xffMode: "off" })
        const ip = limiter.getClientIP(reqWith({}), fakeServer("1.2.3.4:8080"))
        expect(ip).toBe("1.2.3.4")
        limiter.destroy()
    })
})

describe("RateLimiter getClientIP — robustness", () => {
    it("returns 'unknown' when socket has no address and mode is off", () => {
        const limiter = buildLimiter({ xffMode: "off" })
        const ip = limiter.getClientIP(reqWith({}), fakeServer(null))
        expect(ip).toBe("unknown")
        limiter.destroy()
    })

    it("invalid CIDR entries are skipped (no throw at construction)", () => {
        const limiter = buildLimiter({
            xffMode: "strict",
            trustedProxies: ["not-an-ip", "10.0.0.0/8"],
        })
        expect(limiter.getTrustedProxyCount()).toBe(1)
        limiter.destroy()
    })
})
