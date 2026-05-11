/**
 * DEM-665 — feeDistribution.ts unit tests.
 *
 * Stubs `getSharedState.feeDistribution` directly (no DataSource, no
 * Mempool). Each test seeds the percentages it cares about and asserts
 * the emitted GCREditBalance sequence.
 *
 * Invariants covered:
 *  - Sum of `add` amounts equals the `remove` amount for every
 *    component (rounding remainder always lands at treasury).
 *  - Zero-amount components emit nothing.
 *  - Missing rpcAddress + non-zero rpc share: regular tx skips with a
 *    warning; special-ops tx routes the unrouted share into treasury
 *    so the balance still closes.
 *  - Null `feeDistribution` returns empty + logs error.
 *  - `isRollback` is forwarded onto every emitted edit verbatim.
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

interface FeeDistStub {
    burnAddress: string
    treasuryAddress: string
    networkFee: { burnPct: number; treasuryPct: number }
    additionalFee: { burnPct: number; treasuryPct: number }
    specialOps: { burnPct: number; rpcPct: number; treasuryPct: number }
}

const sharedStateStub: { feeDistribution: FeeDistStub | null } = {
    feeDistribution: null,
}

jest.mock("@/utilities/sharedState", () => ({
    __esModule: true,
    getSharedState: sharedStateStub,
}))

import {
    generateFeeDistributionEdits,
    generateSpecialOpsFeeEdits,
} from "@/libs/blockchain/gcr/gcr_routines/feeDistribution"

const BURN = "0x" + "0".repeat(64)
const TREASURY = "0x" + "11".repeat(32)
const SENDER = "0x" + "aa".repeat(32)
const RPC = "0x" + "bb".repeat(32)
const TX = "tx-hash-0001"

function seedDefaults(): void {
    sharedStateStub.feeDistribution = {
        burnAddress: BURN,
        treasuryAddress: TREASURY,
        networkFee: { burnPct: 50, treasuryPct: 50 },
        additionalFee: { burnPct: 25, treasuryPct: 75 },
        specialOps: { burnPct: 25, rpcPct: 50, treasuryPct: 25 },
    }
}

describe("generateFeeDistributionEdits — default 50/50, 100%, 25/75", () => {
    beforeEach(seedDefaults)

    it("returns [] when feeDistribution is null", () => {
        sharedStateStub.feeDistribution = null
        const edits = generateFeeDistributionEdits({
            senderAddress: SENDER,
            rpcAddress: RPC,
            networkFee: 100,
            rpcFee: 10,
            additionalFee: 0,
            txHash: TX,
            isRollback: false,
        })
        expect(edits).toEqual([])
    })

    it("skips network_fee block when networkFee is 0", () => {
        const edits = generateFeeDistributionEdits({
            senderAddress: SENDER,
            rpcAddress: RPC,
            networkFee: 0,
            rpcFee: 10,
            additionalFee: 0,
            txHash: TX,
            isRollback: false,
        })
        expect(
            edits.filter(
                e => e.account === BURN || e.account === TREASURY,
            ),
        ).toHaveLength(0)
    })

    it("emits a 50/50 split for network_fee=100 (3 edits)", () => {
        const edits = generateFeeDistributionEdits({
            senderAddress: SENDER,
            rpcAddress: RPC,
            networkFee: 100,
            rpcFee: 0,
            additionalFee: 0,
            txHash: TX,
            isRollback: false,
        })
        expect(edits).toHaveLength(3)
        expect(
            edits.find(
                e => e.operation === "remove" && e.account === SENDER,
            )?.amount,
        ).toBe(100)
        expect(
            edits.find(e => e.account === BURN)?.amount,
        ).toBe(50)
        expect(
            edits.find(e => e.account === TREASURY)?.amount,
        ).toBe(50)
    })

    it("emits rpc_fee block 100% to rpc operator when rpcAddress present", () => {
        const edits = generateFeeDistributionEdits({
            senderAddress: SENDER,
            rpcAddress: RPC,
            networkFee: 0,
            rpcFee: 7,
            additionalFee: 0,
            txHash: TX,
            isRollback: false,
        })
        expect(edits).toHaveLength(2)
        expect(
            edits.find(e => e.operation === "remove")?.amount,
        ).toBe(7)
        expect(
            edits.find(e => e.operation === "add" && e.account === RPC)
                ?.amount,
        ).toBe(7)
    })

    it("skips rpc_fee block (and logs warning) when rpcAddress is null", () => {
        const edits = generateFeeDistributionEdits({
            senderAddress: SENDER,
            rpcAddress: null,
            networkFee: 0,
            rpcFee: 50,
            additionalFee: 0,
            txHash: TX,
            isRollback: false,
        })
        expect(edits).toHaveLength(0)
    })

    it("emits additional_fee 25/75 split (3 edits)", () => {
        const edits = generateFeeDistributionEdits({
            senderAddress: SENDER,
            rpcAddress: RPC,
            networkFee: 0,
            rpcFee: 0,
            additionalFee: 100,
            txHash: TX,
            isRollback: false,
        })
        expect(edits).toHaveLength(3)
        expect(edits.find(e => e.account === BURN)?.amount).toBe(25)
        expect(edits.find(e => e.account === TREASURY)?.amount).toBe(75)
    })

    it("rounding remainder lands at treasury", () => {
        sharedStateStub.feeDistribution!.networkFee = {
            burnPct: 50,
            treasuryPct: 50,
        }
        const edits = generateFeeDistributionEdits({
            senderAddress: SENDER,
            rpcAddress: null,
            networkFee: 7,
            rpcFee: 0,
            additionalFee: 0,
            txHash: TX,
            isRollback: false,
        })
        expect(edits.find(e => e.account === BURN)?.amount).toBe(3)
        expect(edits.find(e => e.account === TREASURY)?.amount).toBe(4)
        const removed =
            edits.find(e => e.operation === "remove")?.amount ?? 0
        const added = edits
            .filter(e => e.operation === "add")
            .reduce((s, e) => s + (e.amount as number), 0)
        expect(added).toBe(removed)
    })

    it("0% burn means no burn edit, treasury gets full component", () => {
        sharedStateStub.feeDistribution!.networkFee = {
            burnPct: 0,
            treasuryPct: 100,
        }
        const edits = generateFeeDistributionEdits({
            senderAddress: SENDER,
            rpcAddress: null,
            networkFee: 50,
            rpcFee: 0,
            additionalFee: 0,
            txHash: TX,
            isRollback: false,
        })
        expect(edits.find(e => e.account === BURN)).toBeUndefined()
        expect(edits.find(e => e.account === TREASURY)?.amount).toBe(50)
    })

    it("forwards isRollback onto every emitted edit", () => {
        const edits = generateFeeDistributionEdits({
            senderAddress: SENDER,
            rpcAddress: RPC,
            networkFee: 100,
            rpcFee: 10,
            additionalFee: 0,
            txHash: TX,
            isRollback: true,
        })
        for (const e of edits) {
            expect(e.isRollback).toBe(true)
        }
    })

    it("emits all three blocks in order: network → rpc → additional", () => {
        const edits = generateFeeDistributionEdits({
            senderAddress: SENDER,
            rpcAddress: RPC,
            networkFee: 100,
            rpcFee: 7,
            additionalFee: 100,
            txHash: TX,
            isRollback: false,
        })
        const firstBurnIdx = edits.findIndex(e => e.account === BURN)
        const rpcIdx = edits.findIndex(e => e.account === RPC)
        const lastBurnIdx = edits.length - 1 - edits
            .slice()
            .reverse()
            .findIndex(e => e.account === BURN)
        expect(firstBurnIdx).toBeLessThan(rpcIdx)
        expect(rpcIdx).toBeLessThan(lastBurnIdx)
    })
})

describe("generateSpecialOpsFeeEdits — 25/50/25 burn/rpc/treasury", () => {
    beforeEach(seedDefaults)

    it("returns [] when feeDistribution is null", () => {
        sharedStateStub.feeDistribution = null
        const edits = generateSpecialOpsFeeEdits(
            SENDER,
            RPC,
            100,
            TX,
            false,
        )
        expect(edits).toEqual([])
    })

    it("returns [] for totalFee=0", () => {
        const edits = generateSpecialOpsFeeEdits(SENDER, RPC, 0, TX, false)
        expect(edits).toEqual([])
    })

    it("emits 4 edits for 100 fee with the SPEC default split", () => {
        const edits = generateSpecialOpsFeeEdits(
            SENDER,
            RPC,
            100,
            TX,
            false,
        )
        expect(edits).toHaveLength(4)
        expect(
            edits.find(e => e.operation === "remove")?.amount,
        ).toBe(100)
        expect(edits.find(e => e.account === BURN)?.amount).toBe(25)
        expect(edits.find(e => e.account === RPC)?.amount).toBe(50)
        expect(edits.find(e => e.account === TREASURY)?.amount).toBe(25)
    })

    it("rounding remainder lands at treasury (3 doesn't split cleanly)", () => {
        const edits = generateSpecialOpsFeeEdits(SENDER, RPC, 3, TX, false)
        expect(edits.find(e => e.account === BURN)).toBeUndefined()
        expect(edits.find(e => e.account === RPC)?.amount).toBe(1)
        expect(edits.find(e => e.account === TREASURY)?.amount).toBe(2)
        const removed =
            edits.find(e => e.operation === "remove")?.amount ?? 0
        const added = edits
            .filter(e => e.operation === "add")
            .reduce((s, e) => s + (e.amount as number), 0)
        expect(added).toBe(removed)
    })

    it("folds unrouted rpc share into treasury when rpcAddress is null", () => {
        const edits = generateSpecialOpsFeeEdits(
            SENDER,
            null,
            100,
            TX,
            false,
        )
        expect(edits).toHaveLength(3)
        expect(edits.find(e => e.account === BURN)?.amount).toBe(25)
        expect(edits.find(e => e.account === TREASURY)?.amount).toBe(75)
        expect(edits.find(e => e.account === RPC)).toBeUndefined()
    })

    it("forwards isRollback verbatim", () => {
        const edits = generateSpecialOpsFeeEdits(
            SENDER,
            RPC,
            100,
            TX,
            true,
        )
        for (const e of edits) {
            expect(e.isRollback).toBe(true)
        }
    })
})
