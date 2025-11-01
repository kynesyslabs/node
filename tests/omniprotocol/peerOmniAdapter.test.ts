import { beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals"

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

let DEFAULT_OMNIPROTOCOL_CONFIG: typeof import("src/libs/omniprotocol/types/config")
    ["DEFAULT_OMNIPROTOCOL_CONFIG"]
let PeerOmniAdapter: typeof import("src/libs/omniprotocol/integration/peerAdapter")
    ["default"]

beforeAll(async () => {
    ;({ DEFAULT_OMNIPROTOCOL_CONFIG } = await import("src/libs/omniprotocol/types/config"))
    ;({ default: PeerOmniAdapter } = await import("src/libs/omniprotocol/integration/peerAdapter"))
})

const createMockPeer = () => {
    return {
        identity: "mock-peer",
        call: jest.fn(async () => ({
            result: 200,
            response: "ok",
            require_reply: false,
            extra: null,
        })),
        longCall: jest.fn(async () => ({
            result: 200,
            response: "ok",
            require_reply: false,
            extra: null,
        })),
    }
}

describe("PeerOmniAdapter", () => {
    let adapter: PeerOmniAdapter

    beforeEach(() => {
        adapter = new PeerOmniAdapter({
            config: DEFAULT_OMNIPROTOCOL_CONFIG,
        })
    })

    it("falls back to HTTP when migration mode is HTTP_ONLY", async () => {
        const peer = createMockPeer()
        const request = { method: "ping", params: [] }

        const response = await adapter.adaptCall(
            peer as any,
            request as any,
        )

        expect(response.result).toBe(200)
        expect(peer.call).toHaveBeenCalledTimes(1)
    })

    it("honors omni peer allow list in OMNI_PREFERRED mode", async () => {
        const peer = createMockPeer()

        adapter.migrationMode = "OMNI_PREFERRED"
        expect(adapter.shouldUseOmni(peer.identity)).toBe(false)

        adapter.markOmniPeer(peer.identity)
        expect(adapter.shouldUseOmni(peer.identity)).toBe(true)

        adapter.markHttpPeer(peer.identity)
        expect(adapter.shouldUseOmni(peer.identity)).toBe(false)
    })

    it("treats OMNI_ONLY mode as always-on", () => {
        adapter.migrationMode = "OMNI_ONLY"
        expect(adapter.shouldUseOmni("any-peer"))
            .toBe(true)
    })
})
