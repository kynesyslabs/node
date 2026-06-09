/**
 * Audit C1 (admission-side) — verifyGcrEditsMatch.
 *
 * Proves the forged-edit guard's comparison logic: a tx whose attached
 * gcr_edits equal the regenerated set verifies as a match; a tx carrying a
 * forged edit (an unauthorised balance mint) or a tampered amount does NOT.
 *
 * The SDK is mocked in the jest env (see jest.config moduleNameMapper), so
 * GCRGeneration.generate and denomination.serializeTransactionContent are
 * stubbed here with controlled behaviour: generate() returns a fixed
 * "canonical" edit set, and the serializer is an identity passthrough (the
 * amount-normalisation path is the SDK's concern, separately tested). This
 * isolates and verifies THIS module's regenerate→normalise→hash→compare
 * logic and its fork guard.
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

jest.mock("@/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getLastBlockNumber: jest.fn(async () => 0) },
}))

jest.mock("@/forks/forkGates", () => ({
    __esModule: true,
    isForkActive: jest.fn(() => false),
}))

// Control the regenerated edit set. Mutated per-test via mockGenerate.
const mockGenerate = jest.fn()
jest.mock("@kynesyslabs/demosdk/websdk", () => ({
    __esModule: true,
    GCRGeneration: {
        generate: (...args: unknown[]) => mockGenerate(...args),
    },
}))

// Identity passthrough serializer: return the envelope unchanged so the
// comparison reflects the raw edit sets (amount-shape normalisation is the
// SDK's job and is covered by its own tests).
jest.mock("@kynesyslabs/demosdk", () => ({
    __esModule: true,
    denomination: {
        serializeTransactionContent: (content: unknown) =>
            JSON.stringify(content),
    },
}))

import type { Transaction, GCREdit } from "@kynesyslabs/demosdk/types"
import { verifyGcrEditsMatch } from "@/libs/blockchain/validation/verifyGcrEdits"

const SENDER = "0x" + "aa".repeat(32)
const RECIPIENT = "0x" + "bb".repeat(32)
const ATTACKER = "0x" + "cc".repeat(32)

/** The canonical edit set a native send(100) would regenerate. */
function canonicalSendEdits(): GCREdit[] {
    return [
        {
            type: "balance",
            operation: "remove",
            account: SENDER,
            amount: 100,
            txhash: "",
        },
        {
            type: "balance",
            operation: "add",
            account: RECIPIENT,
            amount: 100,
            txhash: "",
        },
    ] as unknown as GCREdit[]
}

function makeTx(gcrEdits: GCREdit[]): Transaction {
    return {
        hash: "tx-native-send-1",
        blockNumber: 0,
        content: {
            type: "native",
            from: SENDER,
            from_ed25519_address: SENDER,
            gcr_edits: gcrEdits,
            data: ["native", { nativeOperation: "send", args: [RECIPIENT, 100] }],
        },
    } as unknown as Transaction
}

describe("verifyGcrEditsMatch — forged-edit guard (audit C1)", () => {
    beforeEach(() => {
        jest.clearAllMocks()
        // generate() returns a FRESH copy each call so the helper's in-place
        // txhash/expectedPrior blanking never mutates the canonical fixture.
        mockGenerate.mockImplementation(async () =>
            JSON.parse(JSON.stringify(canonicalSendEdits())),
        )
    })

    it("matches when shipped gcr_edits equal the regenerated set", async () => {
        const tx = makeTx(canonicalSendEdits())
        const result = await verifyGcrEditsMatch(tx)
        expect(result.match).toBe(true)
        expect(result.txEditsHash).toBe(result.regenEditsHash)
    })

    it("rejects a forged balance-mint edit appended to a valid tx", async () => {
        const forged: GCREdit = {
            type: "balance",
            operation: "add",
            account: ATTACKER,
            amount: 1_000_000_000_000,
            txhash: "",
        } as unknown as GCREdit
        const tx = makeTx([...canonicalSendEdits(), forged])

        const result = await verifyGcrEditsMatch(tx)
        expect(result.match).toBe(false)
        expect(result.txEditsHash).not.toBe(result.regenEditsHash)
    })

    it("rejects a tampered amount on an otherwise-valid edit", async () => {
        const tampered = canonicalSendEdits()
        ;(tampered[1] as { amount: number }).amount = 999_999_999
        const tx = makeTx(tampered)

        const result = await verifyGcrEditsMatch(tx)
        expect(result.match).toBe(false)
    })

    it("rejects when gcr_edits is empty but the body implies edits", async () => {
        const tx = makeTx([])
        const result = await verifyGcrEditsMatch(tx)
        expect(result.match).toBe(false)
    })

    it("is invariant to txhash differences on the shipped edits", async () => {
        // Same edits but with a non-empty txhash — the helper blanks txhash on
        // both sides, so this must still match.
        const withHash = canonicalSendEdits().map(e => ({
            ...e,
            txhash: "0xdeadbeef",
        })) as unknown as GCREdit[]
        const tx = makeTx(withHash)

        const result = await verifyGcrEditsMatch(tx)
        expect(result.match).toBe(true)
    })
})
