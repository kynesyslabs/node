/**
 * An inbound socket that never authenticates must not keep memory alive.
 * close() only half-closes the socket, so a client that never sends its FIN
 * kept it open in CLOSING after the auth timeout, and every byte it sent
 * afterwards was still appended to the framer.
 */

import { describe, expect, it, mock } from "bun:test"
import { EventEmitter } from "events"
import forge from "node-forge"
import { OmniOpcode } from "../protocol/opcodes"

mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: mock(() => {}),
        info: mock(() => {}),
        warn: mock(() => {}),
        warning: mock(() => {}),
        error: mock(() => {}),
        only: mock(() => {}),
        custom: mock(() => {}),
    },
}))
mock.module("src/utilities/sharedState", () => ({
    getSharedState: {
        genesisBlockHash: "d5".repeat(32),
        publicKeyHex: "0x" + "cd".repeat(32),
        getConnectionString: async () => "",
        version: "test",
        getInfo: async () => ({}),
    },
}))

mock.module("src/libs/network/manageNodeCall", () => ({
    manageNodeCall: async () => ({ result: 200, response: "ok", require_reply: false, extra: null }),
}))

const { PeerConnection } = await import("./PeerConnection")
const { ConnectionState } = await import("./types")
const { MessageFramer } = await import("./MessageFramer")
const { InvalidAuthBlockFormatError } = await import("../types/errors")
const { PEER_CLOSE_GRACE_MS, PREAUTH_MAX_PAYLOAD_SIZE } = await import("../constants")
const { encodeNodeCallRequest, decodeNodeCallResponse } = await import("../serialization/control")
const log: any = (await import("src/utilities/logger")).default

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
        const closed = mock(() => {})
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

    it("closes a pending connection that announces a frame above the pre-auth cap", () => {
        const socket = new StubbornSocket()
        const conn: any = new PeerConnection("pending:test", "", socket as any)

        socket.emit("data", partialFrame(PREAUTH_MAX_PAYLOAD_SIZE + 1, 64 * 1024))

        expect(bufferedBytes(conn)).toBe(0)
        expect(socket.ended).toBe(true)
        expect(conn.getState()).toBeLessThanOrEqual(ConnectionState.CLOSING)
    })

    it("accepts a frame up to the pre-auth cap before authentication", () => {
        const socket = new StubbornSocket()
        const conn: any = new PeerConnection("pending:test", "", socket as any)

        socket.emit("data", partialFrame(PREAUTH_MAX_PAYLOAD_SIZE, 64 * 1024))

        expect(bufferedBytes(conn)).toBeGreaterThan(64 * 1024)
        expect(conn.getState()).toBe(ConnectionState.PENDING_AUTH)
        expect(socket.ended).toBe(false)
        conn.close()
    })

    it("restores the full frame limit once the connection authenticates", () => {
        const socket = new StubbornSocket()
        const conn: any = new PeerConnection("pending:test", "", socket as any)
        conn.adoptVerifiedIdentity("0x" + "ab".repeat(32))

        socket.emit("data", partialFrame(PREAUTH_MAX_PAYLOAD_SIZE * 2, 64 * 1024))

        expect(bufferedBytes(conn)).toBeGreaterThan(64 * 1024)
        expect(conn.getState()).toBe(ConnectionState.READY)
        expect(socket.ended).toBe(false)
        conn.close()
    })
})

describe("MessageFramer auth block parse errors", () => {
    it("logs a bounded line instead of the whole buffer", () => {
        // Header with the auth flag, then an auth block whose identity claims
        // 65535 bytes and is cut short, so parsing fails on every chunk.
        const header = Buffer.alloc(12)
        header.writeUInt16BE(1, 0)
        header.writeUInt8(0x10, 2)
        header.writeUInt8(0x01, 3)
        header.writeUInt32BE(8, 4)
        header.writeUInt32BE(1, 8)
        const authHead = Buffer.alloc(12)
        authHead.writeUInt8(1, 0) // algorithm
        authHead.writeUInt8(1, 1) // signature mode
        authHead.writeUInt16BE(0xffff, 10) // identity length
        const framer = new MessageFramer()
        framer.addData(Buffer.concat([header, authHead, Buffer.alloc(60 * 1024, 0x43)]))

        log.error.mockClear()
        expect(() => framer.extractMessage()).toThrow(InvalidAuthBlockFormatError)

        const lines: string[] = log.error.mock.calls.map((c: unknown[]) => String(c[0]))
        expect(lines.length).toBeGreaterThan(0)
        for (const line of lines) {
            expect(line.length).toBeLessThan(512)
        }
    })
})

/** One end of an in-memory TCP link; closing either end closes both. */
class LinkedSocket extends EventEmitter {
    peer!: LinkedSocket
    remoteAddress = "198.51.100.1"
    remotePort = 42000
    localAddress = "198.51.100.2"
    localPort = 53551
    writable = true
    destroyed = false
    ended = false
    written: Buffer[] = []
    setNoDelay() {}
    setKeepAlive() {}
    write(buf: Buffer, cb?: (e?: Error) => void) {
        this.written.push(buf)
        const peer = this.peer
        setImmediate(() => {
            if (!peer.destroyed) peer.emit("data", buf)
        })
        cb?.()
        return true
    }
    end() {
        this.ended = true
        this.destroy()
    }
    destroy() {
        for (const side of [this, this.peer]) {
            if (side.destroyed) continue
            side.destroyed = true
            side.writable = false
            setImmediate(() => side.emit("close"))
        }
    }
}

function link(): [LinkedSocket, LinkedSocket] {
    const a = new LinkedSocket()
    const b = new LinkedSocket()
    a.peer = b
    b.peer = a
    return [a, b]
}

describe("PeerConnection large first request", () => {
    const pair = forge.pki.ed25519.generateKeyPair()
    const publicKey = Buffer.from(pair.publicKey)
    const privateKey = Buffer.from(pair.privateKey)

    /** A dialled connection and the peer's fresh inbound side of it. */
    function connected() {
        const [outSocket, inSocket] = link()
        const outbound: any = new PeerConnection("0x" + "cd".repeat(32), "tcp://198.51.100.2:53551")
        outbound.socket = outSocket
        outbound.setupSocketHandlers()
        outbound._state = ConnectionState.READY
        const inbound: any = new PeerConnection("pending:test", "", inSocket as any)
        return { outbound, inbound, outSocket, inSocket }
    }

    const nodeCall = (bytes: number) =>
        encodeNodeCallRequest({ method: "getBulk", params: [{ blob: "x".repeat(bytes) }] })
    const opcodesSent = (socket: LinkedSocket) => socket.written.map(frame => frame.readUInt8(2))

    it("gets a request above the pre-auth cap through on a fresh connection", async () => {
        const { outbound, inbound, inSocket } = connected()
        const payload = nodeCall(PREAUTH_MAX_PAYLOAD_SIZE + 1024)
        expect(payload.length).toBeGreaterThan(PREAUTH_MAX_PAYLOAD_SIZE)

        const response = await outbound.sendAuthenticated(OmniOpcode.NODE_CALL, payload, privateKey, publicKey)

        expect(decodeNodeCallResponse(response).status).toBe(200)
        expect(inbound.getState()).toBe(ConnectionState.READY)
        expect(inbound.peerIdentity).toBe("0x" + publicKey.toString("hex"))
        expect(inSocket.destroyed).toBe(false)
        await outbound.close()
    })

    it("proves the identity once for concurrent large requests", async () => {
        const { outbound, outSocket } = connected()
        const payload = nodeCall(PREAUTH_MAX_PAYLOAD_SIZE + 1)

        await Promise.all([
            outbound.sendAuthenticated(OmniOpcode.NODE_CALL, payload, privateKey, publicKey),
            outbound.sendAuthenticated(OmniOpcode.NODE_CALL, payload, privateKey, publicKey),
        ])
        await outbound.sendAuthenticated(OmniOpcode.NODE_CALL, payload, privateKey, publicKey)

        expect(opcodesSent(outSocket)).toEqual([
            OmniOpcode.PROTO_PING,
            OmniOpcode.NODE_CALL,
            OmniOpcode.NODE_CALL,
            OmniOpcode.NODE_CALL,
        ])
        await outbound.close()
    })

    it("adds no round trip to a request within the pre-auth cap", async () => {
        const { outbound, outSocket } = connected()

        await outbound.sendAuthenticated(OmniOpcode.NODE_CALL, nodeCall(1024), privateKey, publicKey)

        expect(opcodesSent(outSocket)).toEqual([OmniOpcode.NODE_CALL])
        await outbound.close()
    })
})
