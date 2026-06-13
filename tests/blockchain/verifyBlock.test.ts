/**
 * Audit C2 — verifyBlock: hash recompute + signature-quorum on the sync path.
 *
 * Deps are mocked (SDK + consensus shard lookup + verify) so this isolates
 * verifyBlock's own logic: hash comparison, shard filtering, and the 2/3
 * quorum math. The crypto verify is stubbed to accept a fixed allowlist of
 * (identity) so we control which signatures "pass".
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

// Canonical block hash = "HASH:" + content.n (deterministic, controllable).
jest.mock("@/forks", () => ({
    __esModule: true,
    serializeBlockContent: (content: { n: number }) => `BLK:${content.n}`,
}))

// Hashing.sha256(x) = "H(" + x + ")" so we can predict expectedHash.
jest.mock("src/libs/crypto/hashing", () => ({
    __esModule: true,
    default: { sha256: (s: string) => `H(${s})` },
}))

jest.mock("@/utilities/sharedState", () => ({
    __esModule: true,
    getSharedState: { signingAlgorithm: "ed25519" },
}))

jest.mock("@kynesyslabs/demosdk/encryption", () => ({
    __esModule: true,
    hexToUint8Array: (h: string) => new Uint8Array(Buffer.from(h, "hex")),
}))

// Height-stable validator set, controllable per test. verifyBlock resolves it
// via GCR.getGCRValidatorsAtBlock(block.number-1) -> [{address}].
let SHARD: string[] = []
jest.mock("src/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: {
        getGCRValidatorsAtBlock: async () =>
            SHARD.map(address => ({ address })),
    },
}))

// verify() passes iff the identity is in VALID_SIGNERS.
let VALID_SIGNERS: Set<string> = new Set()
const mockVerify = jest.fn(
    async (args: { publicKey: Uint8Array }) => {
        const idHex = Buffer.from(args.publicKey).toString("hex")
        return VALID_SIGNERS.has(idHex)
    },
)
jest.mock("@/libs/blockchain/validation/txValidatorPool", () => ({
    __esModule: true,
    default: { getInstance: () => ({ verify: mockVerify }) },
}))

import { verifyBlock } from "@/libs/blockchain/validation/verifyBlock"

// identities must be valid hex (hexToUint8Array). Use 2-char hex per signer.
const A = "aa"
const B = "bb"
const C = "cc"
const D = "dd"

function block(n: number, sigs: Record<string, string>) {
    return {
        number: n,
        // hash must equal H(BLK:n) for the recompute to match.
        hash: `H(BLK:${n})`,
        content: { n },
        validation_data: { signatures: sigs },
    } as never
}

describe("verifyBlock — sync-path quorum (audit C2)", () => {
    beforeEach(() => {
        jest.clearAllMocks()
        SHARD = [A, B, C, D] // 4 validators -> threshold floor(4*2/3)+1 = 3
        VALID_SIGNERS = new Set([A, B, C, D])
    })

    it("accepts genesis (block 0) unconditionally", async () => {
        const r = await verifyBlock(block(0, {}))
        expect(r.valid).toBe(true)
    })

    it("accepts a block with a 2/3 quorum of valid in-shard signatures", async () => {
        const r = await verifyBlock(block(5, { [A]: "01", [B]: "02", [C]: "03" }))
        expect(r.valid).toBe(true)
    })

    it("rejects when the block hash does not recompute", async () => {
        const b = block(5, { [A]: "01", [B]: "02", [C]: "03" })
        ;(b as { hash: string }).hash = "H(BLK:WRONG)"
        const r = await verifyBlock(b)
        expect(r.valid).toBe(false)
        expect(r.reason).toMatch(/hash mismatch/i)
    })

    it("rejects below-quorum (only 2 of 4, need 3)", async () => {
        const r = await verifyBlock(block(5, { [A]: "01", [B]: "02" }))
        expect(r.valid).toBe(false)
        expect(r.reason).toMatch(/insufficient/i)
    })

    it("does not count signatures from non-shard signers", async () => {
        // A,B valid+in-shard (2); D is valid crypto but NOT in shard here.
        SHARD = [A, B, C, D]
        VALID_SIGNERS = new Set([A, B, "ee"])
        // "ee" not in shard -> ignored; only A,B count = 2 < 3.
        const r = await verifyBlock(block(5, { [A]: "01", [B]: "02", ee: "05" }))
        expect(r.valid).toBe(false)
    })

    it("does not count signatures that fail crypto verification", async () => {
        VALID_SIGNERS = new Set([A, B]) // C's sig will fail verify
        const r = await verifyBlock(block(5, { [A]: "01", [B]: "02", [C]: "03" }))
        expect(r.valid).toBe(false) // 2 verified < 3
    })

    it("rejects when validation_data.signatures is missing", async () => {
        const b = block(5, {})
        ;(b as { validation_data: unknown }).validation_data = {}
        const r = await verifyBlock(b)
        expect(r.valid).toBe(false)
    })

    it("rejects on empty validator set", async () => {
        SHARD = []
        const r = await verifyBlock(block(5, { [A]: "01" }))
        expect(r.valid).toBe(false)
        expect(r.reason).toMatch(/empty validator set/i)
    })

    it("verifies a deep-history (non-tip) block via the height-stable set (C2-deep)", async () => {
        // Block 999 far from any tip — verifyBlock resolves the signer set
        // height-stably (getGCRValidatorsAtBlock), not from the current tip,
        // so a deep block validates with a real quorum.
        const r = await verifyBlock(
            block(999, { [A]: "01", [B]: "02", [C]: "03" }),
        )
        expect(r.valid).toBe(true)
    })
})
