/**
 * Audit H2 — ed25519 tx must have from === from_ed25519_address.
 *
 * validateTxSignature's ed25519 branch verifies the main signature against
 * `from` but never bound `from_ed25519_address` to it, so a tx could be signed
 * by `from` while recording a different ed25519 identity (identity-confusion).
 * The fix rejects the mismatch before the crypto verify; a matching pair still
 * proceeds to (mocked) signature verification.
 *
 * SDK crypto is mocked via the direct build-path imports the worker uses.
 */

import { describe, expect, it, jest } from "@jest/globals"

const mockVerify = jest.fn(async () => true)
jest.mock(
    "../../node_modules/@kynesyslabs/demosdk/build/encryption/unifiedCrypto.js",
    () => ({
        __esModule: true,
        unifiedCrypto: { verify: (...a: unknown[]) => mockVerify(...a) },
        hexToUint8Array: (h: string) => new Uint8Array(Buffer.from(h, "hex")),
    }),
)
jest.mock(
    "../../node_modules/@kynesyslabs/demosdk/build/denomination/serializerGate.js",
    () => ({
        __esModule: true,
        serializeTransactionContent: (c: unknown) => JSON.stringify(c),
    }),
)

import type { Transaction } from "@kynesyslabs/demosdk/types"
import { validateTxSignature } from "@/libs/blockchain/validation/txValidator"

const KEY_A = "aa".repeat(32)
const KEY_B = "bb".repeat(32)
const SIG = "cc".repeat(64)

function ed25519Tx(from: string, fromEd: string): Transaction {
    return {
        hash: "deadbeef",
        signature: { type: "ed25519", data: SIG },
        content: { type: "native", from, from_ed25519_address: fromEd },
    } as unknown as Transaction
}

describe("ed25519 from/from_ed25519_address binding (audit H2)", () => {
    beforeEach(() => jest.clearAllMocks())

    it("rejects when from != from_ed25519_address (no crypto verify reached)", async () => {
        const r = await validateTxSignature(ed25519Tx(KEY_A, KEY_B), null)
        expect(r.valid).toBe(false)
        expect(r.reason).toMatch(/does not match 'from_ed25519_address'/i)
        expect(mockVerify).not.toHaveBeenCalled()
    })

    it("accepts a matching pair (proceeds to signature verify)", async () => {
        const r = await validateTxSignature(ed25519Tx(KEY_A, KEY_A), null)
        expect(r.valid).toBe(true)
        expect(mockVerify).toHaveBeenCalled()
    })

    it("rejects matching pair when the main signature is invalid", async () => {
        mockVerify.mockResolvedValueOnce(false as never)
        const r = await validateTxSignature(ed25519Tx(KEY_A, KEY_A), null)
        expect(r.valid).toBe(false)
        expect(r.reason).toMatch(/signature verification failed/i)
    })

    it("is case-insensitive on the address comparison", async () => {
        const r = await validateTxSignature(
            ed25519Tx(KEY_A.toUpperCase(), KEY_A),
            null,
        )
        expect(r.valid).toBe(true)
    })
})
