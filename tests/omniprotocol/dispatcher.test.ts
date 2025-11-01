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

let dispatchOmniMessage: typeof import("src/libs/omniprotocol/protocol/dispatcher")
    ["dispatchOmniMessage"]
let OmniOpcode: typeof import("src/libs/omniprotocol/protocol/opcodes")["OmniOpcode"]
let handlerRegistry: typeof import("src/libs/omniprotocol/protocol/registry")
    ["handlerRegistry"]
let UnknownOpcodeError: typeof import("src/libs/omniprotocol/types/errors")
    ["UnknownOpcodeError"]

beforeAll(async () => {
    ;({ dispatchOmniMessage } = await import("src/libs/omniprotocol/protocol/dispatcher"))
    ;({ OmniOpcode } = await import("src/libs/omniprotocol/protocol/opcodes"))
    ;({ handlerRegistry } = await import("src/libs/omniprotocol/protocol/registry"))
    ;({ UnknownOpcodeError } = await import("src/libs/omniprotocol/types/errors"))
})

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
