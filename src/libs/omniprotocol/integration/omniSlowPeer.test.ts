/**
 * A slow peer must not push its other calls back onto HTTP. A request that
 * times out leaves the shared connection open for the requests beside it,
 * and an Omni port that does not answer is retried less and less often.
 */

import { afterEach, describe, expect, it, jest, setSystemTime } from "bun:test"

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
}
jest.mock("src/utilities/sharedState", () => ({ getSharedState: sharedState }))

// What the next sendAuthenticated on a stub connection does
const script: ("timeout" | "slow-ok")[] = []
const connectOptions: any[] = []
let created = 0
let connectGate: Promise<void> = Promise.resolve()

jest.mock("../transport/PeerConnection", () => {
    const { EventEmitter } = require("events")
    const errors = require("../types/errors")
    const { encodeNodeCallResponse } = require("../serialization/control")
    class PeerConnection extends EventEmitter {
        origin = "outbound"
        state = 1 // CONNECTING
        pending = new Set<(e: Error) => void>()
        constructor(
            public peerIdentity: string,
            public connectionString: string,
        ) {
            super()
            created++
        }
        getState() {
            return this.state
        }
        getInfo() {
            return {
                peerIdentity: this.peerIdentity,
                lastActivity: 0,
                inFlightCount: this.pending.size,
            }
        }
        async connect(options: unknown) {
            connectOptions.push(options)
            await connectGate
            this.state = 11 // READY
        }
        sendAuthenticated() {
            const step = script.shift()
            return new Promise((resolve, reject) => {
                this.pending.add(reject)
                const delay = step === "timeout" ? 10 : 50
                setTimeout(() => {
                    if (!this.pending.delete(reject)) return
                    if (step === "timeout") {
                        reject(new errors.RequestTimeoutError("Request timeout after 10ms"))
                    } else {
                        resolve(
                            encodeNodeCallResponse({
                                status: 200,
                                value: "ok",
                                requireReply: false,
                                extra: null,
                            }),
                        )
                    }
                }, delay)
            })
        }
        async close() {
            this.state = 13
            for (const reject of this.pending) {
                reject(new (errors.ConnectionLostError ?? Error)("Connection closing"))
            }
            this.pending.clear()
        }
    }
    return { PeerConnection }
})

const { PeerOmniAdapter } = await import("./peerAdapter")
const { ConnectionPool } = await import("../transport/ConnectionPool")
const { DEFAULT_OMNIPROTOCOL_CONFIG } = await import("../types/config")

const PEER = "0x" + "ab".repeat(32)
const URL_A = "http://10.0.0.9:53550"
const T0 = new Date("2026-01-01T00:00:00.000Z")

afterEach(() => {
    setSystemTime()
    script.length = 0
    connectOptions.length = 0
    created = 0
    connectGate = Promise.resolve()
})

function adapterWithPool(pool: InstanceType<typeof ConnectionPool>) {
    const adapter = new PeerOmniAdapter()
    adapter.migrationMode = "OMNI_PREFERRED"
    ;(adapter as any).getPrivateKey = () => Buffer.alloc(64)
    ;(adapter as any).getPublicKey = () => Buffer.alloc(32)
    ;(adapter as any).connectionPool = pool
    adapter.recordOmniEndpoint(PEER, URL_A, 63551)
    return adapter
}

function fakePeer() {
    return {
        identity: PEER,
        isLocalNode: false,
        connection: { string: URL_A },
        httpCall: jest.fn(async () => ({
            result: 200,
            response: "http",
            require_reply: false,
            extra: null,
        })),
    } as any
}

describe("one call timing out on a shared connection", () => {
    it("leaves the call beside it to finish over Omni", async () => {
        const pool = new ConnectionPool()
        const adapter = adapterWithPool(pool)
        const peer = fakePeer()
        script.push("slow-ok")
        await adapter.adaptCall(peer, { method: "ping", params: [] })
        script.push("timeout", "slow-ok")

        const [slow, sibling] = await Promise.all([
            adapter.adaptCall(peer, { method: "mempool", params: [] }),
            adapter.adaptCall(peer, { method: "consensus_routine", params: [] }),
        ])

        expect(slow.result).toBe(504)
        expect(sibling.result).toBe(200)
        expect(sibling.response).toBe("ok")
        expect(peer.httpCall).not.toHaveBeenCalled()
        expect(adapter.shouldUseOmni(PEER, URL_A)).toBe(true)
        expect(created).toBe(1)
        await pool.shutdown?.()
    })
})

describe("a lost connection", () => {
    it("is not resent over HTTP and does not start a cooldown", async () => {
        const pool = new ConnectionPool()
        const adapter = adapterWithPool(pool)
        const peer = fakePeer()
        script.push("slow-ok")

        const call = adapter.adaptCall(peer, { method: "consensus_routine", params: [] })
        await new Promise(resolve => setTimeout(resolve, 5))
        for (const connection of pool.getConnections(PEER)) {
            await (connection as any).close()
        }
        const response = await call

        expect(response.result).toBe(503)
        expect(peer.httpCall).not.toHaveBeenCalled()
        expect(adapter.shouldUseOmni(PEER, URL_A)).toBe(true)
        await pool.shutdown?.()
    })
})

describe("connect", () => {
    it("never takes longer than the call it serves", async () => {
        const pool = new ConnectionPool({ connectTimeout: 5000 })
        const adapter = adapterWithPool(pool)
        script.push("slow-ok")
        await adapter.adaptCall(fakePeer(), { method: "ping", params: [] }, true, 3000)
        expect(connectOptions[0].timeout).toBe(3000)
        await pool.shutdown?.()
    })

    it("is shared by a burst of first calls to one peer", async () => {
        const pool = new ConnectionPool({ maxConnectionsPerPeer: 2 })
        let open!: () => void
        connectGate = new Promise<void>(resolve => {
            open = resolve
        })
        const acquiring = [1, 2, 3].map(() =>
            pool.acquire(PEER, "tcp://10.0.0.9:63551"),
        )
        open()
        const connections = await Promise.all(acquiring)

        expect(created).toBe(1)
        expect(new Set(connections).size).toBe(1)
        await pool.shutdown?.()
    })
})

describe("an Omni port that keeps failing", () => {
    function adapterWithCooldown(cooldown: number) {
        const adapter = new PeerOmniAdapter({
            config: {
                ...DEFAULT_OMNIPROTOCOL_CONFIG,
                migration: {
                    ...DEFAULT_OMNIPROTOCOL_CONFIG.migration,
                    mode: "OMNI_PREFERRED",
                    httpFallbackCooldown: cooldown,
                },
            },
        })
        adapter.recordOmniEndpoint(PEER, URL_A, 63551)
        return adapter
    }

    function httpOnlyFor(adapter: InstanceType<typeof PeerOmniAdapter>) {
        const until = (adapter as any).httpOnlyUntil.get(PEER)
        return until - Date.now()
    }

    it("is retried after a cooldown that doubles up to ten minutes", () => {
        setSystemTime(T0)
        const adapter = adapterWithCooldown(60_000)
        const cooldowns: number[] = []
        for (let i = 0; i < 6; i++) {
            adapter.markHttpPeer(PEER)
            cooldowns.push(httpOnlyFor(adapter))
        }
        expect(cooldowns).toEqual([
            60_000, 120_000, 240_000, 480_000, 600_000, 600_000,
        ])
    })

    it("starts over once the peer answers over Omni", () => {
        setSystemTime(T0)
        const adapter = adapterWithCooldown(60_000)
        adapter.markHttpPeer(PEER)
        adapter.markHttpPeer(PEER)
        adapter.noteOmniAnswer(PEER)
        adapter.markHttpPeer(PEER)
        expect(httpOnlyFor(adapter)).toBe(60_000)
    })

    it("is not cut short by the same advert in a repeated hello", () => {
        setSystemTime(T0)
        const adapter = adapterWithCooldown(60_000)
        adapter.markHttpPeer(PEER)
        adapter.recordOmniEndpoint(PEER, URL_A, 63551)
        expect(adapter.shouldUseOmni(PEER, URL_A)).toBe(false)

        // A new port is worth trying at once
        adapter.recordOmniEndpoint(PEER, URL_A, 63552)
        expect(adapter.shouldUseOmni(PEER, URL_A)).toBe(true)
    })
})
