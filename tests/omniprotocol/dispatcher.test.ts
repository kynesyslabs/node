import { describe, expect, it, jest } from "@jest/globals"

import { dispatchOmniMessage } from "src/libs/omniprotocol/protocol/dispatcher"
import { OmniOpcode } from "src/libs/omniprotocol/protocol/opcodes"
import { handlerRegistry } from "src/libs/omniprotocol/protocol/registry"
import { UnknownOpcodeError } from "src/libs/omniprotocol/types/errors"

const makeMessage = (opcode: number) => ({
    header: {
        version: 1,
        opcode,
        sequence: 42,
        payloadLength: 0,
    },
    payload: null,
    checksum: 0,
})

const makeContext = () => ({
    peerIdentity: "peer",
    connectionId: "conn",
    receivedAt: Date.now(),
    requiresAuth: false,
})

describe("dispatchOmniMessage", () => {
    it("invokes the registered handler and returns its buffer", async () => {
        const descriptor = handlerRegistry.get(OmniOpcode.PING)!
        const originalHandler = descriptor.handler
        const mockBuffer = Buffer.from("pong")

        descriptor.handler = jest.fn(async () => mockBuffer)

        const fallback = jest.fn(async () => Buffer.from("fallback"))

        const result = await dispatchOmniMessage({
            message: makeMessage(OmniOpcode.PING),
            context: makeContext(),
            fallbackToHttp: fallback,
        })

        expect(result).toBe(mockBuffer)
        expect(descriptor.handler).toHaveBeenCalledTimes(1)
        expect(fallback).not.toHaveBeenCalled()

        descriptor.handler = originalHandler
    })

    it("throws UnknownOpcodeError for missing registers", async () => {
        await expect(
            dispatchOmniMessage({
                message: makeMessage(0xff + 1),
                context: makeContext(),
                fallbackToHttp: jest.fn(async () => Buffer.alloc(0)),
            }),
        ).rejects.toBeInstanceOf(UnknownOpcodeError)
    })
})

