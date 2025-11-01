/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { beforeAll, describe, expect, it, jest } from "@jest/globals"

jest.mock("@kynesyslabs/demosdk/encryption", () => ({
    __esModule: true,
    ucrypto: {
        getIdentity: jest.fn(async () => ({
            publicKey: new Uint8Array(32),
            algorithm: "ed25519",
        })),
        sign: jest.fn(async () => ({
            signature: new Uint8Array([1, 2, 3, 4]),
        })),
        verify: jest.fn(async () => true),
    },
    uint8ArrayToHex: jest.fn((input: Uint8Array) =>
        Buffer.from(input).toString("hex"),
    ),
    hexToUint8Array: jest.fn((hex: string) => {
        const normalized = hex.startsWith("0x") ? hex.slice(2) : hex
        return new Uint8Array(Buffer.from(normalized, "hex"))
    }),
}))
jest.mock("@kynesyslabs/demosdk/build/multichain/core", () => ({
    __esModule: true,
    default: {},
}))
jest.mock("@kynesyslabs/demosdk/build/multichain/localsdk", () => ({
    __esModule: true,
    default: {},
}))

jest.mock("src/utilities/sharedState", () => ({
    __esModule: true,
    getSharedState: {
        getConnectionString: jest.fn().mockResolvedValue(""),
        version: "1.0.0",
        getInfo: jest.fn().mockResolvedValue({}),
    },
}))

let handlerRegistry: typeof import("src/libs/omniprotocol/protocol/registry")
    ["handlerRegistry"]
let OmniOpcode: typeof import("src/libs/omniprotocol/protocol/opcodes")["OmniOpcode"]

import type { HandlerContext } from "src/libs/omniprotocol/types/message"

beforeAll(async () => {
    ({ handlerRegistry } = await import("src/libs/omniprotocol/protocol/registry"))
    ;({ OmniOpcode } = await import("src/libs/omniprotocol/protocol/opcodes"))
})

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
