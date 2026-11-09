/**
 * A validator that shares its source IP with other clients (NAT, a proxy)
 * must not lose its requests when those clients exhaust the IP's request
 * budget. Both inbound paths are covered: the TLS server's InboundConnection
 * and the plain TCP server's pooled PeerConnection.
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

const PER_IP = 2
const sharedState = {
    getSharedState: {
        omniConfig: {
            rateLimit: {
                enabled: true,
                maxConnectionsPerIP: 100,
                maxRequestsPerSecondPerIP: PER_IP,
                maxRequestsPerSecondPerIdentity: 1_000,
                windowMs: 60_000,
                entryTTL: 60_000,
                cleanupInterval: 60_000,
            },
        },
    },
}
mock.module("@/utilities/sharedState", () => sharedState)
mock.module("src/utilities/sharedState", () => sharedState)

const VALIDATOR = "0x" + "aa".repeat(32)
const eligibility = {
    isMergePeerEligible: async (identity: string) => identity === VALIDATOR,
}
mock.module("src/libs/consensus/mergePeerEligibility", () => eligibility)
mock.module("@/libs/consensus/mergePeerEligibility", () => eligibility)

let dispatched = 0
const dispatcher = {
    dispatchOmniMessage: async () => {
        dispatched++
        return Buffer.from("ok")
    },
}
mock.module("../protocol/dispatcher", () => dispatcher)
mock.module("src/libs/omniprotocol/protocol/dispatcher", () => dispatcher)
mock.module("@/libs/omniprotocol/protocol/dispatcher", () => dispatcher)

let InboundConnection: any
let PeerConnection: any
let ConnectionPool: any
let RateLimiter: any

beforeAll(async () => {
    InboundConnection = (await import("./InboundConnection")).InboundConnection
    PeerConnection = (await import("../transport/PeerConnection")).PeerConnection
    ConnectionPool = (await import("../transport/ConnectionPool")).ConnectionPool
    RateLimiter = (await import("../ratelimit")).RateLimiter
})

const SHARED_IP = "198.51.100.5"
let port = 41000
function fakeSocket(ip: string) {
    const s: any = new EventEmitter()
    s.remoteAddress = ip
    s.remotePort = port++
    s.localAddress = "10.0.0.1"
    s.localPort = 53551
    s.destroyed = false
    s.writable = true
    s.written = [] as Buffer[]
    s.write = (buf: Buffer, cb?: (e?: Error) => void) => {
        s.written.push(buf)
        cb?.()
        return true
    }
    s.destroy = () => {
        s.destroyed = true
    }
    s.end = () => {}
    s.setKeepAlive = () => {}
    s.setNoDelay = () => {}
    s.setTimeout = () => {}
    return s
}

const settle = () => new Promise(r => setTimeout(r, 0))
const header = (sequence: number) => ({ version: 1, opcode: 0x10, sequence, payloadLength: 0 })

describe("per-IP request limit and validators on a shared IP", () => {
    let limiter: any
    beforeEach(() => {
        dispatched = 0
        limiter = new RateLimiter()
    })
    afterEach(() => {
        limiter.stop()
    })

    describe("TLS inbound connection", () => {
        const open = (identity?: string) => {
            const conn = new InboundConnection(fakeSocket(SHARED_IP), `c${port}`, {
                rateLimiter: limiter,
                authTimeout: 60_000,
                connectionTimeout: 60_000,
            })
            if (identity) conn.adoptVerifiedIdentity(identity)
            return conn
        }
        const send = (conn: any, seq: number) =>
            conn.handleMessage({ header: header(seq), payload: Buffer.alloc(0), auth: null })

        it("serves a validator after other clients on its IP used the budget", async () => {
            const validator = open(VALIDATOR)
            await settle()
            const flood = open()
            for (let i = 0; i < PER_IP + 1; i++) await send(flood, i)
            expect(dispatched).toBe(PER_IP)

            dispatched = 0
            await send(validator, 100)
            expect(dispatched).toBe(1)
        })

        it("keeps a proven non-validator identity on the per-IP limit", async () => {
            const someone = open("0x" + "bb".repeat(32))
            await settle()
            for (let i = 0; i < PER_IP + 1; i++) await send(someone, i)
            expect(dispatched).toBe(PER_IP)
        })
    })

    describe("pooled TCP connection", () => {
        let pool: any
        beforeEach(() => {
            ConnectionPool.instance = null
            pool = new ConnectionPool({ authTimeout: 60_000 }, limiter)
        })
        afterEach(async () => {
            await pool.shutdown()
        })

        const open = async (identity?: string) => {
            const conn = pool.handleInboundSocket(fakeSocket(SHARED_IP))
            if (identity) {
                conn.adoptVerifiedIdentity(identity)
                await settle()
                await settle()
            }
            return conn
        }
        const send = (conn: any, seq: number) =>
            conn.handleIncomingRequest(header(seq), Buffer.alloc(0), null)

        it("serves a validator after other clients on its IP used the budget", async () => {
            const validator = await open(VALIDATOR)
            const flood = await open()
            for (let i = 0; i < PER_IP + 1; i++) await send(flood, i)
            expect(dispatched).toBe(PER_IP)

            dispatched = 0
            await send(validator, 100)
            expect(dispatched).toBe(1)
        })

        it("keeps a proven non-validator identity on the per-IP limit", async () => {
            const someone = await open("0x" + "bb".repeat(32))
            for (let i = 0; i < PER_IP + 1; i++) await send(someone, i)
            expect(dispatched).toBe(PER_IP)
        })
    })
})
