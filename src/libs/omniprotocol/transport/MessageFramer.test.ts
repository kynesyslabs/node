import { describe, expect, it } from "bun:test"
import { randomBytes } from "node:crypto"

import { FrameTooLargeError, MessageFramer } from "./MessageFramer"

const frame = (sequence: number, payload: Buffer) =>
    MessageFramer.encodeMessage({ version: 1, opcode: 0x01, sequence, payloadLength: payload.length }, payload)

/** Feeds `data` in pieces of `size` bytes and returns every message that completes. */
function drip(framer: MessageFramer, data: Buffer, size: number) {
    const out = []
    for (let i = 0; i < data.length; i += size) {
        framer.addData(data.subarray(i, i + size))
        for (let m = framer.extractMessage(); m; m = framer.extractMessage()) out.push(m)
    }
    return out
}

describe("MessageFramer.addData", () => {
    it("rebuilds a frame that arrives one byte at a time", () => {
        const payload = randomBytes(5000)
        const messages = drip(new MessageFramer(), frame(7, payload), 1)
        expect(messages.length).toBe(1)
        expect(messages[0].header.sequence).toBe(7)
        expect(messages[0].payload.equals(payload)).toBe(true)
    })

    it("rebuilds an authenticated frame split anywhere without throwing", () => {
        const payload = randomBytes(300)
        const auth = {
            algorithm: 1,
            signatureMode: 6,
            timestamp: 1_794_000_000_000,
            identity: randomBytes(32),
            signature: randomBytes(64),
        }
        const data = MessageFramer.encodeMessage(
            { version: 1, opcode: 0x01, sequence: 9, payloadLength: payload.length },
            payload,
            auth,
        )
        const messages = drip(new MessageFramer(), data, 1)
        expect(messages.length).toBe(1)
        expect(messages[0].payload.equals(payload)).toBe(true)
        expect(messages[0].auth.identity.equals(auth.identity)).toBe(true)
        expect(messages[0].auth.signature.equals(auth.signature)).toBe(true)
        expect(messages[0].auth.timestamp).toBe(auth.timestamp)
    })

    it("splits frames that share a chunk and keeps a partial one for later", () => {
        const a = randomBytes(300)
        const b = randomBytes(40)
        const c = randomBytes(900)
        const third = frame(3, c)
        const framer = new MessageFramer()

        const first = drip(framer, Buffer.concat([frame(1, a), frame(2, b), third.subarray(0, 100)]), 1 << 20)
        expect(first.map(m => m.header.sequence)).toEqual([1, 2])
        expect(framer.getBufferSize()).toBe(100)

        const rest = drip(framer, third.subarray(100), 7)
        expect(rest.length).toBe(1)
        expect(rest[0].payload.equals(c)).toBe(true)
        expect(first[0].payload.equals(a)).toBe(true)
        expect(first[1].payload.equals(b)).toBe(true)
        expect(framer.getBufferSize()).toBe(0)
    })

    it("leaves a returned payload unchanged when later data arrives", () => {
        const a = randomBytes(2000)
        const framer = new MessageFramer()
        // The first frame and the start of the next one share a chunk, so both sit in one storage.
        const next = frame(2, randomBytes(4000))
        const [first] = drip(framer, Buffer.concat([frame(1, a), next.subarray(0, 50)]), 1 << 20)
        const before = Buffer.from(first.payload)

        const later = drip(framer, Buffer.concat([next.subarray(50), frame(3, randomBytes(6000))]), 13)
        expect(later.length).toBe(2)
        expect(first.payload.equals(before)).toBe(true)
        expect(first.payload.equals(a)).toBe(true)
    })

    it("copies a dripped frame a bounded number of times", () => {
        const framer = new MessageFramer()
        const data = frame(1, randomBytes(1 << 18))
        const stores = new Set<unknown>()
        let copied = 0
        let early = 0
        for (let i = 0; i < data.length; i++) {
            framer.addData(data.subarray(i, i + 1))
            const store = (framer as any).store as Buffer
            if (!stores.has(store)) {
                stores.add(store)
                copied += framer.getBufferSize()
            }
            // The frame is complete only at the last byte.
            if (i < data.length - 1 && framer.extractMessage()) early++
        }
        expect(early).toBe(0)
        expect((framer.extractMessage()?.payload as Buffer).length).toBe(1 << 18)
        // One allocation per doubling, and under two frames' worth of bytes moved in total.
        expect(stores.size).toBeLessThanOrEqual(20)
        expect(copied).toBeLessThan(2 * data.length)
    })

    it("drops its storage on clear and on an oversized frame", () => {
        const framer = new MessageFramer()
        framer.addData(frame(1, randomBytes(100)).subarray(0, 50))
        framer.addData(Buffer.from([1]))
        framer.clear()
        expect(framer.getBufferSize()).toBe(0)
        expect((framer as any).store.length).toBe(0)

        framer.setMaxPayloadSize(10)
        framer.addData(frame(1, randomBytes(100)))
        expect(() => framer.extractMessage()).toThrow(FrameTooLargeError)
        expect(framer.getBufferSize()).toBe(0)
        expect((framer as any).store.length).toBe(0)
    })
})
