/**
 * DEM-665 P10c — direct unit coverage of the extracted
 * `applyGasFeeSeparation` helper.
 *
 * The full confirmTransaction surface (signature verification, type
 * dispatcher, signValidityData) is heavy to mock. Now that the fee
 * routine lives in its own module, every external dependency is
 * jest-mockable: getSharedState (PROD flag, signing algo,
 * feeDistribution), ucrypto.getIdentity (node pubkey), GCR
 * (sender balance), forgeToHex (Uint8Array → hex). Each test seeds
 * the mocks it needs and asserts the helper's mutations + result.
 */

import { beforeEach, describe, expect, it, jest } from "@jest/globals"

jest.mock("@/utilities/logger", () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        debug: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        custom: jest.fn(),
    },
}))

const NODE_PUBKEY_BYTES = new Uint8Array(32).fill(0xbb)
const NODE_PUBKEY_HEX = "0x" + "bb".repeat(32)
const SENDER = "0x" + "aa".repeat(32)
const BURN = "0x" + "0".repeat(64)
const TREASURY = "0x" + "11".repeat(32)

interface FeeDistStub {
    burnAddress: string
    treasuryAddress: string
    networkFee: { burnPct: number; treasuryPct: number }
    additionalFee: { burnPct: number; treasuryPct: number }
    specialOps: { burnPct: number; rpcPct: number; treasuryPct: number }
}

const sharedStateStub: {
    PROD: boolean
    signingAlgorithm: string
    networkFee: number
    rpcFee: number
    burnFee: number
    additionalFee: number
    feeDistribution: FeeDistStub | null
} = {
    PROD: false,
    signingAlgorithm: "ed25519",
    networkFee: 10,
    rpcFee: 7,
    burnFee: 0,
    additionalFee: 0,
    feeDistribution: {
        burnAddress: BURN,
        treasuryAddress: TREASURY,
        networkFee: { burnPct: 50, treasuryPct: 50 },
        additionalFee: { burnPct: 25, treasuryPct: 75 },
        specialOps: { burnPct: 25, rpcPct: 50, treasuryPct: 25 },
    },
}

jest.mock("@/utilities/sharedState", () => ({
    __esModule: true,
    getSharedState: sharedStateStub,
}))

// Mock ucrypto.getIdentity → fixed node pubkey, and pass uint8ArrayToHex
// through to the real implementation so the produced rpc_address hex
// is the real lowercase encoding the production code would emit.
jest.mock("@kynesyslabs/demosdk/encryption", () => ({
    __esModule: true,
    ucrypto: {
        getIdentity: jest.fn(async () => ({ publicKey: NODE_PUBKEY_BYTES })),
    },
    uint8ArrayToHex: (u: Uint8Array): string =>
        "0x" + Array.from(u).map(b => b.toString(16).padStart(2, "0")).join(""),
}))

// Mock GCR.getGCRNativeBalance — every test that exercises the PROD
// balance branch will reset the mocked return value.
const getGCRNativeBalanceMock = jest.fn<
    (address: string) => Promise<bigint>
>()
jest.mock("@/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: {
        getGCRNativeBalance: (...args: [string]) =>
            getGCRNativeBalanceMock(...args),
    },
}))

// NOTE: we deliberately do NOT mock @/libs/blockchain/routines/calculateCurrentGas.
// bun test does not auto-isolate module mocks across files, so mocking
// that module here would leak into the existing
// tests/governance/calculateCurrentGas.test.ts run when the suite is
// run together. Instead the real calculateFeeBreakdown is exercised,
// driven by `sharedStateStub.networkFee / rpcFee`. Tests that need a
// pathological breakdown (NaN, Infinity, fractional, negative) bypass
// by setting sharedStateStub values that would not normally occur and
// asserting the helper's sanity check fires — the helper checks
// integer/finite/non-negative on `breakdown.total`.

// forgeToHex passthrough — only called for non-string `from`. Tests
// that exercise that path set tx.content.from to a sentinel and
// verify the mock was called.
const forgeToHexMock = jest.fn<(value: unknown) => string>()
jest.mock("@/libs/crypto/forgeUtils", () => ({
    __esModule: true,
    forgeToHex: (...args: [unknown]) => forgeToHexMock(...args),
}))

import { applyGasFeeSeparation } from "@/libs/blockchain/routines/applyGasFeeSeparation"

function makeTx(opts: {
    from?: string | Uint8Array
    hash?: string
    existingEdits?: unknown[]
} = {}): any {
    return {
        hash: opts.hash ?? "tx-test-001",
        blockNumber: 100,
        content: {
            type: "native",
            from: opts.from ?? SENDER,
            to: "",
            from_ed25519_address: "",
            amount: 0,
            nonce: 0,
            timestamp: 0,
            data: [null, null],
            gcr_edits: opts.existingEdits ?? [],
            transaction_fee: {
                network_fee: null,
                rpc_fee: null,
                additional_fee: null,
                rpc_address: null,
            },
        },
    }
}

describe("applyGasFeeSeparation — happy path", () => {
    beforeEach(() => {
        sharedStateStub.PROD = false
        sharedStateStub.networkFee = 10
        sharedStateStub.rpcFee = 7
        getGCRNativeBalanceMock.mockReset()
        forgeToHexMock.mockReset()
    })

    it("stamps transaction_fee fields with breakdown values + node pubkey", async () => {
        const tx = makeTx()
        const r = await applyGasFeeSeparation(tx)
        expect(r.ok).toBe(true)
        expect(tx.content.transaction_fee.network_fee).toBe(10)
        expect(tx.content.transaction_fee.rpc_fee).toBe(7)
        expect(tx.content.transaction_fee.additional_fee).toBe(0)
        expect(tx.content.transaction_fee.rpc_address).toBe(NODE_PUBKEY_HEX)
    })

    it("prepends fee-distribution edits onto tx.content.gcr_edits", async () => {
        const existing = [
            { type: "balance", operation: "add", account: "0xfeed", amount: 1 },
        ]
        const tx = makeTx({ existingEdits: existing })
        const r = await applyGasFeeSeparation(tx)
        expect(r.ok).toBe(true)
        // Pre-existing edit must remain in last position; fee edits come first.
        const last = tx.content.gcr_edits[tx.content.gcr_edits.length - 1]
        expect(last).toEqual(existing[0])
        // First emitted edit is the network_fee remove from SENDER.
        const first = tx.content.gcr_edits[0]
        expect(first.operation).toBe("remove")
        expect(first.account).toBe(SENDER)
    })

    it("emits a deterministic edit sequence for network/rpc breakdown", async () => {
        const tx = makeTx()
        await applyGasFeeSeparation(tx)
        // 50/50 network split (10 → 5/5) + rpc remove+add (7/7).
        // Total emitted = 3 (network) + 2 (rpc) + 0 (additional=0) = 5 edits.
        expect(tx.content.gcr_edits.length).toBe(5)
        expect(
            tx.content.gcr_edits.find((e: any) => e.account === BURN).amount,
        ).toBe(5)
        expect(
            tx.content.gcr_edits.find((e: any) => e.account === TREASURY).amount,
        ).toBe(5)
        expect(
            tx.content.gcr_edits.find((e: any) => e.account === NODE_PUBKEY_HEX)
                .amount,
        ).toBe(7)
    })
})

describe("applyGasFeeSeparation — sender address resolution", () => {
    beforeEach(() => {
        sharedStateStub.PROD = false
        sharedStateStub.networkFee = 0
        sharedStateStub.rpcFee = 0
        forgeToHexMock.mockReset()
    })

    it("uses tx.content.from directly when it is a string", async () => {
        const tx = makeTx({ from: SENDER })
        const r = await applyGasFeeSeparation(tx)
        expect(r.ok).toBe(true)
        expect(forgeToHexMock).not.toHaveBeenCalled()
    })

    it("coerces via forgeToHex when tx.content.from is not a string", async () => {
        const buf = new Uint8Array(32).fill(0xaa)
        forgeToHexMock.mockReturnValueOnce(SENDER)
        const tx = makeTx({ from: buf as unknown as string })
        const r = await applyGasFeeSeparation(tx)
        expect(r.ok).toBe(true)
        expect(forgeToHexMock).toHaveBeenCalledWith(buf)
    })

    it("returns ok=false with a diagnostic message when forgeToHex throws", async () => {
        forgeToHexMock.mockImplementationOnce(() => {
            throw new Error("bad pubkey shape")
        })
        const tx = makeTx({
            from: new Uint8Array([1, 2, 3]) as unknown as string,
        })
        const r = await applyGasFeeSeparation(tx)
        expect(r.ok).toBe(false)
        if (!r.ok)
            expect(r.message).toMatch(/failed to resolve sender address/)
    })
})

describe("applyGasFeeSeparation — breakdown sanity", () => {
    // Pathological breakdown values are induced by setting the shared
    // state stub's networkFee / rpcFee to non-integer or non-finite
    // numbers. The real calculateFeeBreakdown does
    // `payloadSize * networkFee * surge`; injecting NaN/Infinity/etc
    // propagates through to breakdown.total.

    beforeEach(() => {
        sharedStateStub.PROD = false
    })

    it("rejects a NaN total", async () => {
        sharedStateStub.networkFee = Number.NaN
        sharedStateStub.rpcFee = 0
        const r = await applyGasFeeSeparation(makeTx())
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.message).toMatch(/non-integer total/)
    })

    it("rejects an Infinity total", async () => {
        sharedStateStub.networkFee = Number.POSITIVE_INFINITY
        sharedStateStub.rpcFee = 0
        const r = await applyGasFeeSeparation(makeTx())
        expect(r.ok).toBe(false)
    })

    it("rejects a fractional total", async () => {
        sharedStateStub.networkFee = 0.5
        sharedStateStub.rpcFee = 0
        const r = await applyGasFeeSeparation(makeTx())
        expect(r.ok).toBe(false)
    })

    it("rejects a negative total", async () => {
        sharedStateStub.networkFee = -1
        sharedStateStub.rpcFee = 0
        const r = await applyGasFeeSeparation(makeTx())
        expect(r.ok).toBe(false)
    })
})

describe("applyGasFeeSeparation — PROD balance check", () => {
    beforeEach(() => {
        sharedStateStub.PROD = true
        sharedStateStub.networkFee = 10
        sharedStateStub.rpcFee = 7
        getGCRNativeBalanceMock.mockReset()
    })

    it("rejects when sender balance < total fee", async () => {
        getGCRNativeBalanceMock.mockResolvedValueOnce(16n)
        const r = await applyGasFeeSeparation(makeTx())
        expect(r.ok).toBe(false)
        if (!r.ok)
            expect(r.message).toMatch(/sender balance 16 < total fee 17/)
    })

    it("accepts when sender balance equals total fee", async () => {
        getGCRNativeBalanceMock.mockResolvedValueOnce(17n)
        const r = await applyGasFeeSeparation(makeTx())
        expect(r.ok).toBe(true)
    })

    it("accepts when sender balance exceeds total fee", async () => {
        getGCRNativeBalanceMock.mockResolvedValueOnce(1_000_000n)
        const r = await applyGasFeeSeparation(makeTx())
        expect(r.ok).toBe(true)
    })

    it("returns ok=false when GCR.getGCRNativeBalance throws", async () => {
        getGCRNativeBalanceMock.mockRejectedValueOnce(
            new Error("db connection lost"),
        )
        const r = await applyGasFeeSeparation(makeTx())
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.message).toMatch(/failed to read sender balance/)
    })

    it("does NOT call getGCRNativeBalance when PROD=false", async () => {
        sharedStateStub.PROD = false
        const r = await applyGasFeeSeparation(makeTx())
        expect(r.ok).toBe(true)
        expect(getGCRNativeBalanceMock).not.toHaveBeenCalled()
    })
})
