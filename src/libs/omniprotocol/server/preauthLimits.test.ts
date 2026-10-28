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

const PENDING_AUTH = 3
const CLOSED = -2

class FakePeerConnection extends EventEmitter {
    public readonly origin = "inbound"
    public socket: any
    private state = PENDING_AUTH
    private readonly createdAt = Date.now()
    constructor(
        private id: string,
        _connectionString: string,
        socket?: any,
    ) {
        super()
        this.socket = socket
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

function makeServer(maxConnections: number) {
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
