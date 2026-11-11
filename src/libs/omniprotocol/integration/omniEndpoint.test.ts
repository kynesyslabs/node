/**
 * In OMNI_PREFERRED a peer is called over Omni only once its verified hello
 * reply advertised a port, and only at the address that reply was proven
 * for. A slow answer on a live Omni connection is a timeout like on HTTP,
 * not a reason to resend the call over the client RPC port.
 */

import { describe, expect, it, jest } from "bun:test"

jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        only: jest.fn(),
        custom: jest.fn(),
    },
}))

const sharedState: Record<string, any> = {
    publicKeyHex: "0xself",
    omniConfig: { port: 0, rateLimit: { enabled: false } },
    isOmniProtocolEnabled: true,
    omniAdapter: null,
}
jest.mock("src/utilities/sharedState", () => ({ getSharedState: sharedState }))

const { PeerOmniAdapter } = await import("./peerAdapter")
const { RequestTimeoutError } = await import("../types/errors")
const { default: Peer, DEFAULT_RPC_TIMEOUT_MS } = await import(
    "src/libs/peer/Peer"
)

const PEER = "0x" + "ab".repeat(32)
const URL_A = "http://10.0.0.9:53550"
const URL_B = "http://10.0.0.10:53550"

function preferred() {
    const adapter = new PeerOmniAdapter()
    adapter.migrationMode = "OMNI_PREFERRED"
    ;(adapter as any).getPrivateKey = () => Buffer.alloc(64)
    ;(adapter as any).getPublicKey = () => Buffer.alloc(32)
    return adapter
}

function fakePeer(url = URL_A) {
    return {
        identity: PEER,
        isLocalNode: false,
        connection: { string: url },
        httpCall: jest.fn(async () => ({
            result: 200,
            response: "http",
            require_reply: false,
            extra: null,
        })),
    } as any
}

describe("advertised Omni endpoint", () => {
    it("is required before a peer is called over Omni", () => {
        const adapter = preferred()
        expect(adapter.shouldUseOmni(PEER, URL_A)).toBe(false)
        adapter.recordOmniEndpoint(PEER, URL_A, 63551)
        expect(adapter.shouldUseOmni(PEER, URL_A)).toBe(true)
    })

    it("only holds for the address it was verified at", () => {
        const adapter = preferred()
        adapter.recordOmniEndpoint(PEER, URL_A, 63551)
        expect(adapter.shouldUseOmni(PEER, URL_B)).toBe(false)
    })

    it("is dropped when a verified reply no longer advertises it", () => {
        const adapter = preferred()
        adapter.recordOmniEndpoint(PEER, URL_A, 63551)
        adapter.forgetOmniPeer(PEER)
        expect(adapter.shouldUseOmni(PEER, URL_A)).toBe(false)
    })

    it("rejects a port outside the TCP range", () => {
        const adapter = preferred()
        adapter.recordOmniEndpoint(PEER, URL_A, 70000)
        expect(adapter.shouldUseOmni(PEER, URL_A)).toBe(false)
    })

    it("is dialed at the advertised port, not the RPC port + 1", async () => {
        const adapter = preferred()
        adapter.recordOmniEndpoint(PEER, URL_A, 63551)
        const sendAuthenticated = jest.fn(async () => {
            throw new Error("stop")
        })
        ;(adapter as any).connectionPool = { sendAuthenticated }
        await adapter.adaptCall(fakePeer(), { method: "ping", params: [] })
        const [, connectionString, , , , , options] = sendAuthenticated.mock
            .calls[0] as any[]
        expect(connectionString).toBe("tcp://10.0.0.9:63551")
        expect(options.timeout).toBe(DEFAULT_RPC_TIMEOUT_MS)
    })
})

describe("a request timeout on a live Omni connection", () => {
    it("answers 504 without an HTTP resend or a cooldown", async () => {
        const adapter = preferred()
        adapter.recordOmniEndpoint(PEER, URL_A, 63551)
        ;(adapter as any).connectionPool = {
            sendAuthenticated: jest.fn(async () => {
                throw new RequestTimeoutError("Request timeout after 3000ms")
            }),
        }
        const peer = fakePeer()
        const response = await adapter.adaptCall(peer, {
            method: "consensus_routine",
            params: [],
        })
        expect(response.result).toBe(504)
        expect(peer.httpCall).not.toHaveBeenCalled()
        expect(adapter.shouldUseOmni(PEER, URL_A)).toBe(true)
    })

    it("a failed connect still falls back to HTTP with a cooldown", async () => {
        const adapter = preferred()
        adapter.recordOmniEndpoint(PEER, URL_A, 63551)
        ;(adapter as any).connectionPool = {
            sendAuthenticated: jest.fn(async () => {
                throw new Error("Connection timeout after 5000ms")
            }),
        }
        const peer = fakePeer()
        const response = await adapter.adaptCall(peer, {
            method: "ping",
            params: [],
        })
        expect(response.result).toBe(200)
        expect(peer.httpCall).toHaveBeenCalledTimes(1)
        expect(adapter.shouldUseOmni(PEER, URL_A)).toBe(false)
    })
})

describe("per-call timeout", () => {
    it("reaches the transport from longCall options", async () => {
        const adaptCall = jest.fn(async () => ({
            result: 200,
            response: "ok",
            require_reply: false,
            extra: null,
        }))
        sharedState.omniAdapter = { adaptCall }
        const peer = new Peer(URL_A, PEER)
        await peer.longCall({ method: "mempool", params: [] }, true, {
            retries: 1,
            timeoutMs: 10_000,
        })
        expect((adaptCall.mock.calls[0] as unknown[])[3]).toBe(10_000)
        sharedState.omniAdapter = null
    })
})

describe("protocol option", () => {
    it("keeps calls that ask for HTTP off Omni", async () => {
        const adaptCall = jest.fn()
        sharedState.omniAdapter = { adaptCall }
        const peer = new Peer(URL_A, PEER)
        const httpCall = jest.fn(async () => ({
            result: 200,
            response: "http",
            require_reply: false,
            extra: null,
        }))
        peer.httpCall = httpCall as any
        await peer.longCall({ method: "nodeCall", params: [] }, true, {
            protocol: "http",
            retries: 1,
        })
        expect(adaptCall).not.toHaveBeenCalled()
        expect(httpCall).toHaveBeenCalledTimes(1)
        sharedState.omniAdapter = null
    })
})
