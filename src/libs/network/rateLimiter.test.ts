import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"

const mockGetAuthContext = mock(() => ({
    verified: false,
    identity: null,
    publicKey: null,
    algorithm: null,
}))
const mockGetPeer = mock(() => undefined)

mock.module("./authContext", () => ({
    getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
    setAuthContext: mock(() => undefined),
}))

mock.module("@/libs/peer", () => ({
    PeerManager: {
        getInstance: () => ({
            getPeer: (...args: unknown[]) => mockGetPeer(...args),
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
