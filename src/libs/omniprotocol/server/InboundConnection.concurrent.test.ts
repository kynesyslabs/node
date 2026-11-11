/**
 * Requests on one Omni connection are answered by sequence number, so a
 * slow one (a mempool merge still validating) must not hold back the ones
 * after it (a consensus proposal) from the same peer.
 */

import { describe, expect, it, jest } from "bun:test"
import { EventEmitter } from "events"
import { mockLogger } from "src/utilities/testSupport/coreMocks"

mockLogger("src/utilities/logger")

const gates = new Map<number, Promise<void>>()
jest.mock("../protocol/dispatcher", () => ({
    dispatchOmniMessage: async ({ message }: any) => {
        await gates.get(message.header.sequence)
        return Buffer.from(`answer-${message.header.sequence}`)
    },
}))

const { InboundConnection } = await import("./InboundConnection")
const { MessageFramer } = await import("../transport/MessageFramer")

class FakeSocket extends EventEmitter {
    writable = true
    remoteAddress = "10.0.0.9"
    written: number[] = []
    write(buffer: Buffer, done: (error?: Error) => void) {
        const framer = new MessageFramer()
        framer.addData(buffer)
        this.written.push(framer.extractMessage()!.header.sequence)
        done()
        return true
    }
    destroy() {}
    end() {
        this.emit("close")
    }
}

function frame(sequence: number): Buffer {
    const payload = Buffer.from("{}")
    return MessageFramer.encodeMessage(
        { version: 1, opcode: 0x10, sequence, payloadLength: payload.length },
        payload,
    )
}

describe("one inbound connection", () => {
    it("answers a later request while an earlier one is still running", async () => {
        let releaseSlow!: () => void
        gates.set(
            1,
            new Promise<void>(resolve => {
                releaseSlow = resolve
            }),
        )

        const socket = new FakeSocket()
        const connection = new InboundConnection(socket as any, "c1", {
            authTimeout: 60_000,
            connectionTimeout: 60_000,
        })
        connection.start()

        socket.emit("data", Buffer.concat([frame(1), frame(2)]))
        await new Promise(resolve => setTimeout(resolve, 50))
        expect(socket.written).toEqual([2])

        releaseSlow()
        await new Promise(resolve => setTimeout(resolve, 50))
        expect(socket.written).toEqual([2, 1])

        await connection.close()
    })
})
