/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { describe, expect, it, jest } from "@jest/globals"

import { handlerRegistry } from "src/libs/omniprotocol/protocol/registry"
import { OmniOpcode } from "src/libs/omniprotocol/protocol/opcodes"
import { HandlerContext } from "src/libs/omniprotocol/types/message"

const createHandlerContext = (): HandlerContext => {
    const fallbackToHttp = jest.fn(async () => Buffer.from("fallback"))

    return {
        message: {
            header: {
                version: 1,
                opcode: OmniOpcode.PING,
                sequence: 1,
                payloadLength: 0,
            },
            payload: null,
            checksum: 0,
        },
        context: {
            peerIdentity: "peer",
            connectionId: "conn",
            receivedAt: Date.now(),
            requiresAuth: false,
        },
        fallbackToHttp,
    }
}

describe("handlerRegistry", () => {
    it("returns HTTP fallback buffer by default", async () => {
        const descriptor = handlerRegistry.get(OmniOpcode.PING)
        expect(descriptor).toBeDefined()

        const ctx = createHandlerContext()
        const buffer = await descriptor!.handler(ctx)

        expect(buffer.equals(Buffer.from("fallback"))).toBe(true)
        expect(ctx.fallbackToHttp).toHaveBeenCalledTimes(1)
    })
})

