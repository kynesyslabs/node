/**
 * An authenticated Omni message is good once. Its timestamp and opcode are
 * covered by the signature, so a captured frame cannot be given a fresh
 * timestamp or another opcode, and the same frame sent again inside the
 * freshness window is refused. The signature also names the network
 * (genesis hash), so a frame from another network does not verify.
 */

import { describe, expect, it, jest } from "bun:test"
import { EventEmitter } from "events"
import forge from "node-forge"

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

const OUR_GENESIS = "d5".repeat(32)
const OTHER_GENESIS = "e7".repeat(32)
const sharedState: Record<string, unknown> = { genesisBlockHash: OUR_GENESIS }
jest.mock("src/utilities/sharedState", () => ({
    __esModule: true,
    default: { getInstance: () => sharedState },
    getSharedState: sharedState,
}))

const { PeerConnection } = await import("../transport/PeerConnection")
const { MessageFramer } = await import("../transport/MessageFramer")
const { SignatureVerifier } = await import("./verifier")
const { ReplayCache } = await import("./replayCache")
const { SignatureMode } = await import("./types")
const { OmniOpcode } = await import("../protocol/opcodes")

class FakeSocket extends EventEmitter {
    remoteAddress = "10.0.0.9"
    remotePort = 40000
    writable = true
    written: Buffer[] = []
    setNoDelay() {}
    setKeepAlive() {}
    write(buf: Buffer, cb?: (e?: Error) => void) {
        this.written.push(buf)
        cb?.()
        return true
    }
    end() {}
    destroy() {}
}

const keys = () => {
    const pair = forge.pki.ed25519.generateKeyPair()
    return {
        publicKey: Buffer.from(pair.publicKey),
        privateKey: Buffer.from(pair.privateKey),
    }
}

/** What the real sender writes on the wire for one authenticated request. */
async function sentFrame(opcode = OmniOpcode.NODE_CALL, payload = Buffer.from("hello")) {
    const socket = new FakeSocket()
    const conn = new PeerConnection("0xpeer", "", socket as any)
    ;(conn as any)._state = 11 // READY
    const { publicKey, privateKey } = keys()
    conn.sendAuthenticated(opcode, payload, privateKey, publicKey, { timeout: 20 }).catch(
        () => undefined,
    )
    await new Promise(r => setTimeout(r, 1))
    const framer = new MessageFramer()
    framer.addData(socket.written[0])
    return framer.extractMessage()!
}

const verify = (m: any) => SignatureVerifier.verify(m.auth, m.header, m.payload, true)

describe("Omni auth replay", () => {
    it("accepts a frame from the real sender once", async () => {
        const m = await sentFrame()
        expect((await verify(m)).valid).toBe(true)
    })

    it("refuses the same frame a second time", async () => {
        const m = await sentFrame()
        expect((await verify(m)).valid).toBe(true)
        const again = await verify(m)
        expect(again.valid).toBe(false)
        expect(again.error).toMatch(/replay/i)
    })

    it("refuses a captured frame given a fresh timestamp", async () => {
        const m = await sentFrame()
        const moved = { ...m, auth: { ...m.auth, timestamp: m.auth.timestamp + 1 } }
        expect((await verify(moved)).valid).toBe(false)
    })

    it("refuses a captured frame replayed under another opcode", async () => {
        const m = await sentFrame(OmniOpcode.NODE_CALL)
        const other = { ...m, header: { ...m.header, opcode: OmniOpcode.PROTO_PING } }
        expect((await verify(other)).valid).toBe(false)
    })

    it("refuses the old signature modes that leave the timestamp unsigned", async () => {
        const m = await sentFrame()
        for (const mode of [
            SignatureMode.SIGN_FULL_PAYLOAD,
            SignatureMode.SIGN_MESSAGE_ID_PAYLOAD_HASH,
        ]) {
            const legacy = { ...m, auth: { ...m.auth, signatureMode: mode } }
            const result = await verify(legacy)
            expect(result.valid).toBe(false)
            expect(result.error).toMatch(/timestamp/i)
        }
    })
})

describe("Omni auth network binding", () => {
    it("refuses a frame signed on another network", async () => {
        sharedState.genesisBlockHash = OTHER_GENESIS
        const m = await sentFrame()
        sharedState.genesisBlockHash = OUR_GENESIS
        const result = await verify(m)
        expect(result.valid).toBe(false)
    })

    it("refuses to verify before the node knows its network", async () => {
        const m = await sentFrame()
        sharedState.genesisBlockHash = null
        try {
            expect((await verify(m)).valid).toBe(false)
        } finally {
            sharedState.genesisBlockHash = OUR_GENESIS
        }
    })
})

describe("ReplayCache", () => {
    const WINDOW = 1000

    it("forgets entries once their timestamp is out of the window", () => {
        const cache = new ReplayCache(WINDOW, 10)
        expect(cache.admit("a", "d1", 1000, 1000)).toBe(true)
        expect(cache.admit("a", "d1", 1000, 1500)).toBe(false)
        // Out of the window the verifier refuses the timestamp itself.
        cache.admit("a", "d2", 2600, 2600)
        expect(cache.size).toBe(1)
    })

    it("stays bounded and refuses what it had to forget early", () => {
        const cache = new ReplayCache(WINDOW, 3)
        for (let i = 0; i < 5; i++) {
            expect(cache.admit("a", `d${i}`, 1000 + i, 1000 + i)).toBe(true)
        }
        expect(cache.size).toBe(3)
        // d0 and d1 were evicted early: a replay of either is still refused.
        expect(cache.admit("a", "d0", 1000, 1010)).toBe(false)
        expect(cache.admit("a", "d1", 1001, 1010)).toBe(false)
        // Another identity is not affected by a's evictions.
        expect(cache.admit("b", "d0", 1000, 1010)).toBe(true)
        // a's fresh traffic still passes.
        expect(cache.admit("a", "d9", 1010, 1010)).toBe(true)
    })

    it("still refuses a replay after the floor cap drops a live floor", () => {
        const cache = new ReplayCache(WINDOW, 1, 1)
        expect(cache.admit("a", "da", 1000, 1000)).toBe(true)
        // Each admit evicts the previous sender's entry into a floor; the
        // third pushes a's floor out of the one-floor cap while it is live.
        expect(cache.admit("b", "db", 1001, 1001)).toBe(true)
        expect(cache.admit("c", "dc", 1002, 1002)).toBe(true)
        expect(cache.admit("a", "da", 1000, 1010)).toBe(false)
        expect(cache.admit("b", "db", 1001, 1010)).toBe(false)
        // Traffic newer than every forgotten floor still passes.
        expect(cache.admit("a", "dn", 1005, 1010)).toBe(true)
    })
})
