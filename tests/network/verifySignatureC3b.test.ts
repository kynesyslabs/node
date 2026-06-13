/**
 * Audit C3b — HTTP RPC auth: timestamp-bound signature verification.
 *
 * verifySignature, when requireTimestampBinding=true (nonceEnforcement fork
 * active), must:
 *   - reject a missing timestamp with an upgrade hint,
 *   - reject a stale/malformed timestamp,
 *   - verify the signature over sha256(`${identity}:${timestamp}`),
 * and, when binding is off (pre-fork), keep the legacy bare-pubkey message.
 *
 * The underlying crypto verify is mocked so we assert (a) the gates and (b)
 * the exact message bytes handed to the verifier — that's what proves the
 * binding is in effect.
 */

import { beforeEach, describe, expect, it, jest } from "@jest/globals"

jest.mock("@/utilities/logger", () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        debug: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        only: jest.fn(),
        custom: jest.fn(),
    },
}))

jest.mock("src/libs/crypto/hashing", () => ({
    __esModule: true,
    default: { sha256: (s: string) => `H(${s})` },
}))

let lastVerifiedMessage = ""
const mockVerify = jest.fn(async (obj: { message: Uint8Array }) => {
    lastVerifiedMessage = new TextDecoder().decode(obj.message)
    return true // accept crypto so the test exercises the binding/gate logic
})
jest.mock("../../src/libs/blockchain/validation/txValidatorPool", () => ({
    __esModule: true,
    default: { getInstance: () => ({ verify: mockVerify }) },
}))

jest.mock("@kynesyslabs/demosdk/encryption", () => ({
    __esModule: true,
    ucrypto: {},
    hexToUint8Array: (h: string) => new Uint8Array(Buffer.from(h, "hex")),
}))

import { verifySignature } from "@/libs/network/verifySignature"

const PK = "aa".repeat(32)
const IDENTITY = `ed25519:${PK}`
const SIG = "bb".repeat(64)

describe("verifySignature timestamp binding (audit C3b)", () => {
    beforeEach(() => {
        jest.clearAllMocks()
        lastVerifiedMessage = ""
    })

    it("bound mode: verifies over sha256(identity:timestamp) for a fresh ts", async () => {
        const ts = Date.now().toString()
        const r = await verifySignature(IDENTITY, SIG, ts, true)
        expect(r.valid).toBe(true)
        expect(lastVerifiedMessage).toBe(`H(${IDENTITY}:${ts})`)
    })

    it("bound mode: rejects a missing timestamp with an upgrade hint", async () => {
        const r = await verifySignature(IDENTITY, SIG, null, true)
        expect(r.valid).toBe(false)
        expect(r.error).toMatch(/update your sdk/i)
        expect(mockVerify).not.toHaveBeenCalled()
    })

    it("bound mode: rejects a stale timestamp", async () => {
        const stale = (Date.now() - 10 * 60 * 1000).toString()
        const r = await verifySignature(IDENTITY, SIG, stale, true)
        expect(r.valid).toBe(false)
        expect(r.error).toMatch(/outside acceptable window/i)
    })

    it("bound mode: rejects a malformed timestamp", async () => {
        const r = await verifySignature(IDENTITY, SIG, "not-a-number", true)
        expect(r.valid).toBe(false)
        expect(r.error).toMatch(/malformed timestamp/i)
    })

    it("legacy mode (binding off): verifies over the bare public key", async () => {
        const r = await verifySignature(IDENTITY, SIG, undefined, false)
        expect(r.valid).toBe(true)
        // legacy message is the publicKey hex (splits[1]), NOT hashed
        expect(lastVerifiedMessage).toBe(PK)
    })

    it("legacy mode ignores a provided timestamp (no binding)", async () => {
        const r = await verifySignature(IDENTITY, SIG, Date.now().toString(), false)
        expect(r.valid).toBe(true)
        expect(lastVerifiedMessage).toBe(PK)
    })
})
