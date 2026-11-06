/**
 * The pool connects within its own connect timeout. The request timeout a
 * caller passes bounds the answer and must not stretch the TCP connect.
 * A pooled connection is reused only for the address it was opened to, and an
 * idle one to an address the peer left makes room for its new address.
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

const connectOptions: unknown[] = []
jest.mock("./PeerConnection", () => {
    const { EventEmitter } = require("events")
    class PeerConnection extends EventEmitter {
        origin = "outbound"
        constructor(
            public peerIdentity: string,
            public connectionString: string,
        ) {
            super()
        }
        getState() {
            // READY: usable, so the pool may reuse it
            return 11
        }
        inFlightCount = 0
        closed = false
        getInfo() {
            return {
                peerIdentity: this.peerIdentity,
                lastActivity: 0,
                inFlightCount: this.inFlightCount,
            }
        }
        async connect(options: unknown) {
            connectOptions.push(options)
        }
        async send() {
            return Buffer.alloc(0)
        }
        async close() {
            this.closed = true
        }
    }
    return { PeerConnection }
})

const { ConnectionPool } = await import("./ConnectionPool")

describe("ConnectionPool connect timeout", () => {
    it("uses the pool connect timeout, not the caller's request timeout", async () => {
        const pool = new ConnectionPool({ connectTimeout: 1234 })
        try {
            await pool.send(
                "0xpeer",
                "tcp://10.0.0.9:53551",
                1,
                Buffer.from("x"),
                { timeout: 30_000 },
            )
        } catch {
            // The stub answers with an empty buffer; decoding is not under test.
        }
        expect(connectOptions).toHaveLength(1)
        expect((connectOptions[0] as any).timeout).toBe(1234)
        await pool.shutdown?.()
    })
})

describe("ConnectionPool reuse", () => {
    it("does not answer a call to one address over a socket to another", async () => {
        const pool = new ConnectionPool()
        const toA = await pool.acquire("0xpeer", "tcp://10.0.0.1:53551")
        expect(await pool.acquire("0xpeer", "tcp://10.0.0.1:53551")).toBe(toA)
        // The same identity at another address: proving that address needs
        // a socket that actually reaches it.
        const toB = await pool.acquire("0xpeer", "tcp://10.0.0.2:53551")
        expect(toB).not.toBe(toA)
        expect(toB!.connectionString).toBe("tcp://10.0.0.2:53551")
        await pool.shutdown?.()
    })
})

describe("ConnectionPool per-peer limit after an address change", () => {
    const A = "tcp://10.0.0.1:53551"
    const B = "tcp://10.0.0.2:53551"
    const C = "tcp://10.0.0.3:53551"

    it("retires an idle connection to an old address for the new one", async () => {
        const pool = new ConnectionPool({ maxConnectionsPerPeer: 2 })
        const toA: any = await pool.acquire("0xpeer", A)
        const toB: any = await pool.acquire("0xpeer", B)
        const toC: any = await pool.acquire("0xpeer", C)
        expect(toC.connectionString).toBe(C)
        expect(toA.closed).toBe(true)
        expect(toB.closed).toBe(false)
        expect(pool.getConnections("0xpeer")).toEqual([toB, toC])
        await pool.shutdown?.()
    })

    it("keeps connections with requests in flight and refuses instead", async () => {
        const pool = new ConnectionPool({ maxConnectionsPerPeer: 2 })
        const toA: any = await pool.acquire("0xpeer", A)
        const toB: any = await pool.acquire("0xpeer", B)
        toA.inFlightCount = 1
        toB.inFlightCount = 2
        await expect(pool.acquire("0xpeer", C)).rejects.toThrow("Max connections to peer")
        expect(toA.closed).toBe(false)
        expect(toB.closed).toBe(false)
        expect(pool.getConnections("0xpeer")).toEqual([toA, toB])
        await pool.shutdown?.()
    })
})
