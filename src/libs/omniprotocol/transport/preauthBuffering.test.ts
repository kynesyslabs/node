/**
 * An inbound socket that never authenticates must not keep memory alive.
 * close() only half-closes the socket, so a client that never sends its FIN
 * kept it open in CLOSING after the auth timeout, and every byte it sent
 * afterwards was still appended to the framer.
 */

import { describe, expect, it, jest } from "bun:test"
import { EventEmitter } from "events"

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
jest.mock("src/utilities/sharedState", () => ({
    getSharedState: {
        getConnectionString: async () => "",
        version: "test",
        getInfo: async () => ({}),
    },
}))

const { PeerConnection } = await import("./PeerConnection")
const { ConnectionState } = await import("./types")
const { PEER_CLOSE_GRACE_MS } = await import("../constants")

/** A client that ignores our FIN: end() never leads to "close". */
class StubbornSocket extends EventEmitter {
    remoteAddress = "203.0.113.50"
    remotePort = 41000
    writable = true
    destroyed = false
    ended = false
    setNoDelay() {}
    setKeepAlive() {}
    write(_buf: Buffer, cb?: (e?: Error) => void) {
        cb?.()
        return true
    }
    end() {
        this.ended = true
    }
    destroy() {
        if (this.destroyed) return
        this.destroyed = true
        setImmediate(() => this.emit("close"))
    }
}

/** A frame header announcing `payloadLength` bytes that are never all sent. */
function partialFrame(payloadLength: number, bodyBytes: number): Buffer {
    const header = Buffer.alloc(12)
    header.writeUInt16BE(1, 0) // version
    header.writeUInt8(0x10, 2) // opcode
    header.writeUInt8(0, 3) // flags: no auth block
    header.writeUInt32BE(payloadLength, 4)
    header.writeUInt32BE(1, 8) // sequence
    return Buffer.concat([header, Buffer.alloc(bodyBytes, 0x41)])
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const bufferedBytes = (conn: any): number => conn.framer.getBufferSize()

describe("PeerConnection pre-auth buffering", () => {
    it("destroys a socket that ignores the FIN after the auth timeout", async () => {
        const socket = new StubbornSocket()
        const conn: any = new PeerConnection("pending:test", "", socket as any)
        const closed = jest.fn()
        conn.on("close", closed)

        // Restart the auth timer with a short timeout instead of waiting 5 s.
        clearTimeout(conn.authTimer)
        conn.authTimeout = 20
        conn.startAuthTimeout()

        await sleep(20 + PEER_CLOSE_GRACE_MS + 200)

        expect(socket.ended).toBe(true)
        expect(socket.destroyed).toBe(true)
        expect(conn.getState()).toBe(ConnectionState.CLOSED)
        // The pool frees the connection's slots on this event.
        expect(closed).toHaveBeenCalledTimes(1)
    })

    it("drops what was buffered and ignores data sent after close()", async () => {
        const socket = new StubbornSocket()
        const conn: any = new PeerConnection("pending:test", "", socket as any)

        socket.emit("data", partialFrame(1024 * 1024, 64 * 1024))
        expect(bufferedBytes(conn)).toBeGreaterThan(64 * 1024)

        const closing = conn.close()
        expect(conn.getState()).toBe(ConnectionState.CLOSING)
        expect(bufferedBytes(conn)).toBe(0)

        // The client keeps streaming a new frame into the half-closed socket.
        socket.emit("data", partialFrame(1024 * 1024, 256 * 1024))
        for (let i = 0; i < 2; i++) {
            socket.emit("data", Buffer.alloc(256 * 1024, 0x42))
        }
        expect(bufferedBytes(conn)).toBe(0)

        await closing
        expect(socket.destroyed).toBe(true)
    })
})
