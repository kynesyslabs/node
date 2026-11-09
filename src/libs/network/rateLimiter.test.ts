import { afterEach, beforeEach, describe, expect, it, mock, setSystemTime } from "bun:test"

const mockGetAuthContext = mock(() => ({
    verified: false,
    identity: null,
    publicKey: null,
    algorithm: null,
}))
const mockGetPeer = mock((_identity: string): unknown => undefined)

mock.module("./authContext", () => ({
    getAuthContext: () => mockGetAuthContext(),
    setAuthContext: mock(() => undefined),
}))

mock.module("@/libs/peer", () => ({
    PeerManager: {
        getInstance: () => ({
            getPeer: (identity: string) => mockGetPeer(identity),
        }),
    },
}))

let stakedKeys = new Set<string>()
const refreshStakedSet = mock(async () => stakedKeys as ReadonlySet<string>)
mock.module("@/libs/consensus/stakedSet", () => ({
    getStakedSet: () => refreshStakedSet(),
}))

let validatorRows: unknown[] | Error = []
// The real getter answers a failed read with [], exactly like an empty table.
const getGCRValidatorsAtBlock = mock(async (_height: number) =>
    validatorRows instanceof Error ? [] : validatorRows,
)
const getGCRValidatorsAtBlockOrThrow = mock(async (_height: number) => {
    if (validatorRows instanceof Error) throw validatorRows
    return validatorRows
})
mock.module("@/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: {
        getGCRValidatorsAtBlock: (height: number) => getGCRValidatorsAtBlock(height),
        getGCRValidatorsAtBlockOrThrow: (height: number) =>
            getGCRValidatorsAtBlockOrThrow(height),
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
const { xffModeProblem } = await import("@/libs/blockchain/genesis/genesisPin")

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
        stakedKeys = new Set()
        validatorRows = []

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
        setSystemTime()
        rateLimiter.destroy()
        mockGetAuthContext.mockClear()
        mockGetPeer.mockClear()
        refreshStakedSet.mockClear()
        refreshStakedSet.mockImplementation(async () => stakedKeys as ReadonlySet<string>)
        getGCRValidatorsAtBlock.mockClear()
        getGCRValidatorsAtBlockOrThrow.mockClear()
    })

    it("re-reads an empty validator set at most every few seconds", async () => {
        setSystemTime(new Date(1_000_000))
        await rateLimiter.refreshValidatorKeys()
        await rateLimiter.refreshValidatorKeys()
        expect(refreshStakedSet).toHaveBeenCalledTimes(1)
        expect(getGCRValidatorsAtBlockOrThrow).toHaveBeenCalledTimes(1)

        stakedKeys = new Set(["0xbeef"])
        setSystemTime(new Date(1_005_000))
        await rateLimiter.refreshValidatorKeys()
        expect(refreshStakedSet).toHaveBeenCalledTimes(2)

        await rateLimiter.refreshValidatorKeys()
        expect(refreshStakedSet).toHaveBeenCalledTimes(3)
        expect(getGCRValidatorsAtBlockOrThrow).toHaveBeenCalledTimes(1)
    })

    it("shares one validator read between concurrent signed requests", async () => {
        setSystemTime(new Date(1_000_000))
        let release!: () => void
        const gate = new Promise<void>(resolve => {
            release = resolve
        })
        refreshStakedSet.mockImplementation(async () => {
            await gate
            return stakedKeys as ReadonlySet<string>
        })

        const burst = Array.from({ length: 20 }, () => rateLimiter.refreshValidatorKeys())
        release()
        await Promise.all(burst)

        expect(refreshStakedSet).toHaveBeenCalledTimes(1)
        expect(getGCRValidatorsAtBlockOrThrow).toHaveBeenCalledTimes(1)

        // Past the back-off the next request reads again.
        setSystemTime(new Date(1_005_000))
        await rateLimiter.refreshValidatorKeys()
        expect(refreshStakedSet).toHaveBeenCalledTimes(2)
    })

    it("backs off after a failed validator read too", async () => {
        setSystemTime(new Date(1_000_000))
        validatorRows = new Error("connection terminated")
        await rateLimiter.refreshValidatorKeys()
        await rateLimiter.refreshValidatorKeys()
        expect(refreshStakedSet).toHaveBeenCalledTimes(1)
        expect(getGCRValidatorsAtBlockOrThrow).toHaveBeenCalledTimes(1)
    })

    it("trusts an authenticated staked validator", async () => {
        stakedKeys = new Set(["0xbeef"])
        await rateLimiter.refreshValidatorKeys()
        mockGetAuthContext.mockImplementation(() => ({
            verified: true,
            identity: "ed25519:0xBEEF",
            publicKey: "0xBEEF",
            algorithm: "ed25519",
        }))

        const trusted = rateLimiter.isTrustedInternalRequest(
            new Request("http://localhost/"),
            "172.25.0.4",
        )

        expect(trusted).toBe(true)
    })

    it("does not trust a key only because it is in the peer table", async () => {
        // hello_peer puts any node that asks into the peer table.
        stakedKeys = new Set(["0xbeef"])
        await rateLimiter.refreshValidatorKeys()
        mockGetAuthContext.mockImplementation(() => ({
            verified: true,
            identity: "ed25519:0xpeer",
            publicKey: "0xpeer",
            algorithm: "ed25519",
        }))
        mockGetPeer.mockImplementation(() => ({ identity: "0xpeer" }))

        const trusted = rateLimiter.isTrustedInternalRequest(
            new Request("http://localhost/"),
            "172.25.0.4",
        )

        expect(trusted).toBe(false)
    })

    it("trusts known peers on a network with no validators, unless validators are required", async () => {
        mockGetAuthContext.mockImplementation(() => ({
            verified: true,
            identity: "ed25519:0xpeer",
            publicKey: "0xpeer",
            algorithm: "ed25519",
        }))
        mockGetPeer.mockImplementation(() => ({ identity: "0xpeer" }))
        const req = new Request("http://localhost/")
        await rateLimiter.refreshValidatorKeys()

        expect(rateLimiter.isTrustedInternalRequest(req, "172.25.0.4")).toBe(true)
        expect(mockGetPeer).toHaveBeenCalledWith("0xpeer")

        const previous = process.env.DEMOS_REQUIRE_VALIDATORS
        process.env.DEMOS_REQUIRE_VALIDATORS = "true"
        try {
            expect(rateLimiter.isTrustedInternalRequest(req, "172.25.0.4")).toBe(false)
        } finally {
            if (previous === undefined) delete process.env.DEMOS_REQUIRE_VALIDATORS
            else process.env.DEMOS_REQUIRE_VALIDATORS = previous
        }
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

    it("gives no peer-table exemption when the validator set cannot be read", async () => {
        // The staked set is empty after a failed read too, and the plain
        // getter answers one with []; neither is a network without validators.
        validatorRows = new Error("connection terminated")
        mockGetAuthContext.mockImplementation(() => ({
            verified: true,
            identity: "ed25519:0xpeer",
            publicKey: "0xpeer",
            algorithm: "ed25519",
        }))
        mockGetPeer.mockImplementation(() => ({ identity: "0xpeer" }))
        await rateLimiter.refreshValidatorKeys()

        expect(rateLimiter.isTrustedInternalRequest(new Request("http://localhost/"), "172.25.0.4")).toBe(false)
        expect(getGCRValidatorsAtBlock).not.toHaveBeenCalled()

        validatorRows = [{ address: "0xbeef" }]
        await rateLimiter.refreshValidatorKeys()
        expect(rateLimiter.isTrustedInternalRequest(new Request("http://localhost/"), "172.25.0.4")).toBe(false)
    })

    it("does not trust unknown authenticated callers", async () => {
        stakedKeys = new Set(["0xbeef"])
        await rateLimiter.refreshValidatorKeys()
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
        expect(mockGetPeer).not.toHaveBeenCalled()
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

// The boot check (findGenesisBlock) reads the mode through explicitXffMode, the
// same function the constructor uses, so what it refuses is what the limiter
// would run as.
describe("explicitXffMode — boot refusal of XFF_MODE=legacy on a mainnet chain id", () => {
    const saved = process.env.XFF_MODE
    afterEach(() => {
        if (saved === undefined) delete process.env.XFF_MODE
        else process.env.XFF_MODE = saved
    })

    const bootProblem = (configValue: string | undefined, chainId: number) =>
        xffModeProblem(rateLimiterModule.explicitXffMode(configValue), chainId)

    it("refuses legacy from the config value or from the env override", () => {
        delete process.env.XFF_MODE
        expect(bootProblem("legacy", 4242)).toContain("XFF_MODE=legacy")
        // the loader reads the env into the config; a bare limiter reads it itself
        process.env.XFF_MODE = "legacy"
        expect(bootProblem(undefined, 4242)).toContain("XFF_MODE=legacy")
        expect(bootProblem("", 4242)).toContain("XFF_MODE=legacy")
    })

    it("treats the empty string docker-compose passes as unset", () => {
        process.env.XFF_MODE = ""
        expect(rateLimiterModule.explicitXffMode("")).toBeUndefined()
        expect(bootProblem("", 4242)).toBeNull()
    })

    it("config wins over env, as in the constructor", () => {
        process.env.XFF_MODE = "legacy"
        expect(bootProblem("strict", 4242)).toBeNull()
        process.env.XFF_MODE = "strict"
        expect(bootProblem("legacy", 4242)).toContain("XFF_MODE=legacy")
    })

    it("allows legacy on the testnet and devnet ids", () => {
        process.env.XFF_MODE = "legacy"
        expect(bootProblem(undefined, 1)).toBeNull()
        expect(bootProblem(undefined, 1337)).toBeNull()
    })

    it("agrees with the mode the limiter resolves", () => {
        for (const [configValue, env] of [
            ["", "legacy"],
            ["legacy", ""],
            ["strict", "legacy"],
            ["", ""],
            ["", "LEGACY"],
        ] as const) {
            process.env.XFF_MODE = env
            const limiter = buildLimiter({ xffMode: configValue as "off" })
            const refused = bootProblem(configValue, 4242) !== null
            expect(refused).toBe(limiter.getXffMode() === "legacy")
            limiter.destroy()
        }
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
