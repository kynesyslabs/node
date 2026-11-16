/**
 * At the per-identity connection cap, a new inbound connection that proved
 * the key takes the slot of the least recently used one. Refusing it instead
 * let a halted copy of a validator key, holding both slots, lock the live
 * validator out of its peers and stall consensus (launch rehearsal, phase A
 * of the key-copy drill). The cap counts the peer's inbound connections
 * only: our outbound sockets to it never take its slots.
 */

import { beforeAll, describe, expect, it, mock } from "bun:test"
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

let ConnectionPool: any
beforeAll(async () => {
    ConnectionPool = (await import("./ConnectionPool")).ConnectionPool
})

const KEY = "0x" + "ab".repeat(32)
let port = 42000
function fakeSocket() {
    const s: any = new EventEmitter()
    s.remoteAddress = "203.0.113.7"
    s.remotePort = port++
    s.localAddress = "10.0.0.1"
    s.localPort = 53551
    s.destroyed = false
    s.writable = true
    s.write = (_buf: Buffer, cb?: (e?: Error) => void) => {
        cb?.()
        return true
    }
    s.destroy = () => {
        s.destroyed = true
        s.writable = false
    }
    s.end = () => {}
    s.setKeepAlive = () => {}
    s.setNoDelay = () => {}
    s.setTimeout = () => {}
    return s
}
const settle = () => new Promise(r => setTimeout(r, 0))

describe("per-identity connection cap", () => {
    it("gives the slot of the least recently used inbound connection to a new proven one", async () => {
        const pool = new ConnectionPool({ maxConnectionsPerPeer: 2 })
        const open = (lastActivity: number) => {
            const conn = pool.handleInboundSocket(fakeSocket())
            conn.adoptVerifiedIdentity(KEY)
            ;(conn as any).lastActivity = lastActivity
            return conn
        }
        const idle = open(1_000)
        const busy = open(5_000)
        const fresh = open(Date.now())
        await settle()

        const held = pool.getConnections(KEY)
        expect(held).toHaveLength(2)
        expect(held).toContain(fresh)
        expect(held).toContain(busy)
        expect(held).not.toContain(idle)
        expect(fresh.isUsable()).toBe(true)
        expect(idle.isUsable()).toBe(false)
        await pool.shutdown?.()
    })

    it("evicts an idle inbound connection before an older one that waits for a reply", async () => {
        const pool = new ConnectionPool({ maxConnectionsPerPeer: 2 })
        const open = (lastActivity: number) => {
            const conn = pool.handleInboundSocket(fakeSocket())
            conn.adoptVerifiedIdentity(KEY)
            ;(conn as any).lastActivity = lastActivity
            return conn
        }
        const waiting = open(1_000)
        let rejected: Error | undefined
        waiting.inFlightRequests.set(1, {
            resolve: () => {},
            reject: (e: Error) => {
                rejected = e
            },
            timer: setTimeout(() => {}, 0),
            sentAt: 1_000,
        })
        const idle = open(5_000)
        const fresh = open(Date.now())
        await settle()

        const held = pool.getConnections(KEY)
        expect(held).toHaveLength(2)
        expect(held).toContain(fresh)
        expect(held).toContain(waiting)
        expect(held).not.toContain(idle)
        expect(rejected).toBeUndefined()
        waiting.inFlightRequests.clear()
        await pool.shutdown?.()
    })

    it("evicts an idle inbound connection before an older one still answering a peer request", async () => {
        const pool = new ConnectionPool({ maxConnectionsPerPeer: 2 })
        const open = (lastActivity: number) => {
            const conn = pool.handleInboundSocket(fakeSocket())
            conn.adoptVerifiedIdentity(KEY)
            ;(conn as any).lastActivity = lastActivity
            return conn
        }
        const answering = open(1_000)
        ;(answering as any).servingRequests = 1
        const idle = open(5_000)
        const fresh = open(Date.now())
        await settle()

        const held = pool.getConnections(KEY)
        expect(held).toHaveLength(2)
        expect(held).toContain(fresh)
        expect(held).toContain(answering)
        expect(held).not.toContain(idle)
        await pool.shutdown?.()
    })

    it("does not count our own outbound connections against the peer's inbound slots", async () => {
        const pool = new ConnectionPool({ maxConnectionsPerPeer: 1 })
        const ours: any = { origin: "outbound", getState: () => 20, getLastActivity: () => 0, socketId: "ours", close: async () => {} }
        ;(pool as any).connections.set(KEY, [ours])
        const theirs = pool.handleInboundSocket(fakeSocket())
        theirs.adoptVerifiedIdentity(KEY)
        await settle()
        expect(pool.getConnections(KEY)).toEqual([ours, theirs])
        expect(theirs.isUsable()).toBe(true)
        await pool.shutdown?.()
    })

    it("admits a second inbound connection next to our outbound one without evicting the live inbound one", async () => {
        const pool = new ConnectionPool({ maxConnectionsPerPeer: 2 })
        const ours: any = { origin: "outbound", getState: () => 20, getLastActivity: () => 0, socketId: "ours", close: async () => {} }
        ;(pool as any).connections.set(KEY, [ours])
        const open = (lastActivity: number) => {
            const conn = pool.handleInboundSocket(fakeSocket())
            conn.adoptVerifiedIdentity(KEY)
            ;(conn as any).lastActivity = lastActivity
            return conn
        }
        const live = open(1_000)
        const second = open(5_000)
        await settle()
        expect(pool.getConnections(KEY)).toEqual([ours, live, second])
        expect(live.isUsable()).toBe(true)

        // Past the inbound cap the least recently used inbound one goes;
        // our outbound connection is never a candidate.
        const third = open(Date.now())
        await settle()
        expect(pool.getConnections(KEY)).toEqual([ours, second, third])
        expect(live.isUsable()).toBe(false)
        await pool.shutdown?.()
    })
})
