/**
 * In OMNI_PREFERRED a peer is called over Omni only once its verified hello
 * reply advertised a port, and only at the address that reply was proven
 * for. A slow answer on a live Omni connection is a timeout like on HTTP,
 * not a reason to resend the call over the client RPC port.
 */

import { describe, expect, it, jest } from "bun:test"
import { mockCore } from "src/utilities/testSupport/coreMocks"

const sharedState: Record<string, any> = {
    publicKeyHex: "0xself",
    omniConfig: { port: 0, rateLimit: { enabled: false } },
    isOmniProtocolEnabled: true,
    omniAdapter: null,
    keypair: { publicKey: new Uint8Array(32) },
}
mockCore(sharedState)

const { PeerOmniAdapter } = await import("./peerAdapter")
const { RequestTimeoutError } = await import("../types/errors")
const { default: Peer, DEFAULT_RPC_TIMEOUT_MS } = await import(
    "src/libs/peer/Peer"
)
const { default: PeerManager } = await import("src/libs/peer/PeerManager")
const { default: axios } = await import("axios")

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
        const markPeerOffline = jest.spyOn(PeerManager, "markPeerOffline")
        const peer = fakePeer()
        const response = await adapter.adaptCall(peer, {
            method: "consensus_routine",
            params: [],
        })
        expect(response.result).toBe(504)
        expect(peer.httpCall).not.toHaveBeenCalled()
        expect(adapter.shouldUseOmni(PEER, URL_A)).toBe(true)
        // The connection stays open, so the peer stays in the online table
        expect(markPeerOffline).not.toHaveBeenCalled()
        markPeerOffline.mockRestore()
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
        // What the connect left of the budget, and its timeout proves nothing
        const [, , budget, flags] = peer.httpCall.mock.calls[0] as any[]
        expect(budget).toBeGreaterThan(0)
        expect(budget).toBeLessThanOrEqual(DEFAULT_RPC_TIMEOUT_MS)
        expect(flags).toEqual({ offlineOnTimeout: false })
    })

    it("a connect that left too little of the call's budget is not retried over HTTP", async () => {
        const adapter = preferred()
        adapter.recordOmniEndpoint(PEER, URL_A, 63551)
        ;(adapter as any).connectionPool = {
            sendAuthenticated: jest.fn(async () => {
                await new Promise(resolve => setTimeout(resolve, 30))
                throw new Error("Connection timeout after 30ms")
            }),
        }
        const peer = fakePeer()
        const response = await adapter.adaptCall(
            peer,
            { method: "mempool", params: [] },
            true,
            300,
        )
        expect(response.result).toBe(504)
        expect(response.extra.inconclusive).toBe(true)
        expect(peer.httpCall).not.toHaveBeenCalled()
        expect(adapter.shouldUseOmni(PEER, URL_A)).toBe(false)
    })
})

describe("an answer that cannot be decoded", () => {
    it("is an error, not a reason to send the request again over HTTP", async () => {
        const adapter = preferred()
        adapter.recordOmniEndpoint(PEER, URL_A, 63551)
        ;(adapter as any).connectionPool = {
            sendAuthenticated: jest.fn(async () => Buffer.from([0xff])),
        }
        const peer = fakePeer()
        const response = await adapter.adaptCall(peer, {
            method: "mempool",
            params: [],
        })
        expect(response.result).toBe(502)
        expect(peer.httpCall).not.toHaveBeenCalled()
        // Later calls avoid the Omni server we cannot read
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

describe("an HTTP timeout", () => {
    async function timedOut(flags?: { offlineOnTimeout: boolean }) {
        const post = jest.spyOn(axios, "post").mockImplementation(async () => {
            throw Object.assign(new Error("timeout"), {
                isAxiosError: true,
                code: "ECONNABORTED",
            })
        })
        const markPeerOffline = jest
            .spyOn(PeerManager, "markPeerOffline")
            .mockImplementation(() => undefined)
        const peer = new Peer(URL_A, PEER)
        const response = await peer.httpCall(
            { method: "ping", params: [] },
            false,
            100,
            flags,
        )
        const marked = markPeerOffline.mock.calls.length
        post.mockRestore()
        markPeerOffline.mockRestore()
        return { response, marked }
    }

    it("on a full budget takes the peer offline", async () => {
        const { response, marked } = await timedOut()
        expect(response.result).toBe(504)
        expect(marked).toBe(1)
    })

    it("on a budget an Omni connect cut short does not", async () => {
        const { response, marked } = await timedOut({ offlineOnTimeout: false })
        expect(response.result).toBe(504)
        expect(response.extra.inconclusive).toBe(true)
        expect(marked).toBe(0)
    })
})

describe("a liveness ping", () => {
    it("asks again when a failed Omni connect cut the first one short", async () => {
        const peer = new Peer(URL_A, PEER)
        const answers = [
            { result: 504, response: "", require_reply: false, extra: { inconclusive: true } },
            { result: 200, response: "pong", require_reply: false, extra: null },
        ]
        peer.call = jest.fn(async () => answers.shift()) as any
        expect(await peer.connect()).toBe(true)
    })
})

describe("an error escaping the Omni adapter", () => {
    it("is not resent over HTTP", async () => {
        sharedState.omniAdapter = {
            adaptCall: jest.fn(async () => {
                throw new Error("after send")
            }),
        }
        const peer = new Peer(URL_A, PEER)
        const httpCall = jest.fn()
        peer.httpCall = httpCall as any
        const response = await peer.call({ method: "ping", params: [] })
        expect(response.result).toBe(500)
        expect(httpCall).not.toHaveBeenCalled()
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
