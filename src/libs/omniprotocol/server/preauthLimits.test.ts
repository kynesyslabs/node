/**
 * Unauthenticated (PENDING_AUTH) inbound sockets must count toward the
 * server's total capacity and the per-IP connection limit. Before the fix,
 * OmniProtocolServer checked capacity with getTotalConnectionCount() (which
 * skips pending sockets) and decremented the per-IP counter twice per closed
 * socket, so one IP could keep opening sockets that each buffer a partial
 * frame of up to 16 MB until the auth timer fires.
 *
 * PeerConnection is replaced by a fake so no frames, timers or crypto run.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test"
import { EventEmitter } from "events"

const noopLog = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    warning: () => {},
    error: () => {},
    only: () => {},
    custom: () => {},
}
mock.module("src/utilities/logger", () => ({ __esModule: true, default: noopLog }))
mock.module("@/utilities/logger", () => ({ __esModule: true, default: noopLog }))

const MAX_PER_IP = 3
const sharedState = {
    getSharedState: {
        omniConfig: {
            rateLimit: {
                enabled: true,
                maxConnectionsPerIP: MAX_PER_IP,
                maxRequestsPerSecondPerIP: 2_000,
                maxRequestsPerSecondPerIdentity: 1_000,
                windowMs: 1000,
                entryTTL: 60_000,
                cleanupInterval: 10_000,
            },
        },
    },
}
mock.module("@/utilities/sharedState", () => sharedState)
mock.module("src/utilities/sharedState", () => sharedState)
mock.module("@/libs/peer", () => ({
    PeerManager: { getInstance: () => ({ getPeer: () => null }) },
}))

// Identities the chain lists as validators. A lookup can be held open to
// let a connection close while it is in flight.
const validators = new Set<string>()
let lookupGate: Promise<void> | null = null
const eligibility = {
    isMergePeerEligible: async (identity: string) => {
        if (lookupGate) await lookupGate
        return validators.has(identity)
    },
}
mock.module("src/libs/consensus/mergePeerEligibility", () => eligibility)
mock.module("@/libs/consensus/mergePeerEligibility", () => eligibility)

const PENDING_AUTH = 3
const CLOSED = -2

const READY = 11

class FakePeerConnection extends EventEmitter {
    public readonly origin: "inbound" | "outbound"
    public socket: any
    private state = PENDING_AUTH
    private readonly createdAt = Date.now()
    constructor(
        private id: string,
        private connectionString: string,
        socket?: any,
    ) {
        super()
        this.socket = socket
        this.origin = socket ? "inbound" : "outbound"
    }
    /** Outbound dial: the socket's remote end is the peer's address. */
    async connect() {
        const { hostname } = new URL(this.connectionString)
        this.socket = fakeSocket(hostname)
        this.state = READY
    }
    /** What PeerConnection does once an auth block verifies. */
    simulateAuth(identity: string) {
        this.id = identity
        this.state = READY
        this.emit("authenticated", identity)
    }
    get peerIdentity() {
        return this.id
    }
    get socketId() {
        return this.id
    }
    getState() {
        return this.state
    }
    getCreatedAt() {
        return this.createdAt
    }
    getInfo() {
        return { peerIdentity: this.id, lastActivity: this.createdAt, inFlightCount: 0 }
    }
    async close() {
        this.simulateClose()
    }
    /** What PeerConnection does when its socket closes (auth timeout, peer FIN). */
    simulateClose() {
        if (this.state === CLOSED) return
        this.state = CLOSED
        this.socket.destroyed = true
        this.emit("close")
    }
}
mock.module("src/libs/omniprotocol/transport/PeerConnection", () => ({
    PeerConnection: FakePeerConnection,
}))
mock.module("@/libs/omniprotocol/transport/PeerConnection", () => ({
    PeerConnection: FakePeerConnection,
}))

let OmniProtocolServer: any
let ConnectionPool: any
let RateLimiter: any

beforeAll(async () => {
    ;({ OmniProtocolServer } = await import("./OmniProtocolServer"))
    ;({ ConnectionPool } = await import("../transport/ConnectionPool"))
    ;({ RateLimiter } = await import("../ratelimit"))
})

let port = 40000
function fakeSocket(ip: string) {
    const s: any = new EventEmitter()
    s.remoteAddress = ip
    s.remotePort = port++
    s.destroyed = false
    s.destroy = () => {
        s.destroyed = true
    }
    s.setKeepAlive = () => {}
    s.setNoDelay = () => {}
    s.end = () => {}
    return s
}

/** Lets the async validator lookups started by authentication settle. */
const settle = () => new Promise(r => setTimeout(r, 0))

function makeServer(maxConnections: number) {
    validators.clear()
    lookupGate = null
    ;(ConnectionPool as any).instance = null
    ;(RateLimiter as any).instance = null
    const server = new OmniProtocolServer({ port: 1, maxConnections })
    const accepted: any[] = []
    server.connectionPool.on("connection_accepted", () => {})
    const open = (ip: string) => {
        const socket = fakeSocket(ip)
        ;(server as any).handleNewConnection(socket)
        if (!socket.destroyed) accepted.push(socket)
        return socket
    }
    const pending = () => Array.from((server.connectionPool as any).pendingConnections.values()) as FakePeerConnection[]
    return { server, open, pending, accepted }
}

describe("OmniProtocolServer pre-auth limits", () => {
    let current: any

    afterEach(async () => {
        if (current) {
            await current.server.connectionPool.shutdown()
            current.server.getRateLimiter().stop()
        }
        current = null
    })

    it("counts unauthenticated sockets toward maxConnections", () => {
        current = makeServer(3)
        // Three sockets from three IPs, none ever authenticates.
        expect(current.open("10.0.0.1").destroyed).toBe(false)
        expect(current.open("10.0.0.2").destroyed).toBe(false)
        expect(current.open("10.0.0.3").destroyed).toBe(false)
        expect(current.pending().length).toBe(3)

        // A fourth unauthenticated socket must be refused for capacity.
        const fourth = current.open("10.0.0.4")
        expect(fourth.destroyed).toBe(true)
        expect(current.pending().length).toBe(3)
    })

    it("keeps one IP at maxConnectionsPerIP pending sockets across closes", () => {
        current = makeServer(1000)
        const ip = "203.0.113.7"
        for (let i = 0; i < MAX_PER_IP; i++) {
            expect(current.open(ip).destroyed).toBe(false)
        }
        // One pending socket times out / closes: exactly one slot frees up.
        current.pending()[0].simulateClose()
        expect(current.pending().length).toBe(MAX_PER_IP - 1)

        // Keep trying; the IP must never exceed MAX_PER_IP live sockets.
        for (let i = 0; i < 10; i++) current.open(ip)
        const live = current.pending().filter((c: FakePeerConnection) => c.socket.remoteAddress === ip)
        expect(live.length).toBe(MAX_PER_IP)
    })

    it("does not give an IP inbound slots when outbound connections to it close", async () => {
        current = makeServer(1000)
        const ip = "192.0.2.44"
        for (let i = 0; i < MAX_PER_IP; i++) {
            expect(current.open(ip).destroyed).toBe(false)
        }

        // We dial the same host (a peer behind that IP) and those links close.
        const pool = current.server.connectionPool
        for (let i = 0; i < 3; i++) {
            const outbound = await pool.acquire(`peer-${i}`, `tcp://${ip}:53551`)
            expect(outbound.origin).toBe("outbound")
            outbound.simulateClose()
        }

        // The IP's own inbound sockets are still all live, so it gets no more.
        for (let i = 0; i < 5; i++) current.open(ip)
        const live = current.pending().filter((c: FakePeerConnection) => c.socket.remoteAddress === ip)
        expect(live.length).toBe(MAX_PER_IP)
    })

    it("frees a validator's per-IP slot once it authenticates, and only once", async () => {
        current = makeServer(1000)
        const ip = "198.51.100.20" // several validators behind one NAT address
        for (let i = 0; i < MAX_PER_IP; i++) validators.add(`validator-${i}`)
        const first = Array.from({ length: MAX_PER_IP }, () => current.open(ip))
        expect(first.every((s: any) => !s.destroyed)).toBe(true)
        const authenticated = current.pending()
        authenticated.forEach((c: FakePeerConnection, i: number) => c.simulateAuth(`validator-${i}`))
        await settle()
        expect(current.pending().length).toBe(0)

        // Authenticated links no longer count: the IP can open a full set of
        // pending sockets again without being blocked.
        for (let i = 0; i < MAX_PER_IP; i++) {
            expect(current.open(ip).destroyed).toBe(false)
        }

        // Closing the authenticated links must not free a second slot each.
        for (const c of authenticated) c.simulateClose()
        expect(current.open(ip).destroyed).toBe(true)
        expect(current.pending().length).toBe(MAX_PER_IP)
    })

    it("keeps the per-IP slot of an identity that is not a validator", async () => {
        current = makeServer(1000)
        const ip = "203.0.113.66"
        // Each socket proves a fresh self-made key, one at a time.
        for (let i = 0; i < MAX_PER_IP; i++) {
            expect(current.open(ip).destroyed).toBe(false)
            current.pending()[0].simulateAuth(`throwaway-key-${i}`)
            await settle()
        }
        expect(current.pending().length).toBe(0)

        // Proven but unknown identities still count against the IP.
        expect(current.open(ip).destroyed).toBe(true)
        // A different IP is unaffected.
        expect(current.open("203.0.113.67").destroyed).toBe(false)
    })

    it("frees the slot once when a validator closes before its lookup returns", async () => {
        current = makeServer(1000)
        const ip = "198.51.100.30"
        validators.add("validator-a")
        let openGate!: () => void
        lookupGate = new Promise<void>(r => (openGate = r))

        const slotsHeld = () =>
            (current.server.getRateLimiter() as any).ipLimits.get(ip).connections

        for (let i = 0; i < MAX_PER_IP; i++) current.open(ip)
        const conn = current.pending()[0]
        conn.simulateAuth("validator-a")
        await settle()
        // The slot is held while the lookup is in flight ...
        expect(slotsHeld()).toBe(MAX_PER_IP)
        // ... and the close frees it before the lookup answers.
        conn.simulateClose()
        expect(slotsHeld()).toBe(MAX_PER_IP - 1)
        openGate()
        await settle()

        // The late "validator" answer must not free a second slot.
        expect(slotsHeld()).toBe(MAX_PER_IP - 1)
        expect(current.open(ip).destroyed).toBe(false)
        expect(current.open(ip).destroyed).toBe(true)
    })

    it("applies the per-IP check to the first socket from a blocked IP", () => {
        current = makeServer(1000)
        const ip = "198.51.100.9"
        for (let i = 0; i < MAX_PER_IP; i++) current.open(ip)
        // Over the limit: rejected and the IP is blocked for the block window.
        expect(current.open(ip).destroyed).toBe(true)
        // All of its sockets close, so the live count drops to 0 ...
        for (const c of current.pending()) c.simulateClose()
        expect(current.pending().length).toBe(0)
        // ... but the block must still apply to the next (now "first") socket.
        expect(current.open(ip).destroyed).toBe(true)
    })
})
