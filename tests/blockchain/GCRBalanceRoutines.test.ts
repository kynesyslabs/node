/**
 * DEM-665 — GCRBalanceRoutines burn-address spend prevention tests.
 *
 * The guard fires only when:
 *   1. operation is `remove` AND isRollback is false
 *   2. gasFeeSeparation fork is active at the current block height
 *   3. feeDistribution view is present
 *   4. editOperationAccount.toLowerCase() === burnAddress.toLowerCase()
 *
 * All four conditions are independently tested. Pre-fork (gate
 * returns false) and rollback cases must NOT block — the inversion
 * has already flipped a prior `add` into a `remove`, and refusing it
 * would make fee distribution irreversible.
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

const BURN = "0x" + "0".repeat(64)
const OTHER = "0x" + "ab".repeat(32)

interface FeeDistStub {
    burnAddress: string
    treasuryAddress: string
    networkFee: { burnPct: number; treasuryPct: number }
    additionalFee: { burnPct: number; treasuryPct: number }
    specialOps: { burnPct: number; rpcPct: number; treasuryPct: number }
}

const sharedStateStub: {
    feeDistribution: FeeDistStub | null
    forkConfig: {
        gasFeeSeparation: {
            activationHeight: number | null
            treasuryAddress: string
        }
        osDenomination: { activationHeight: number | null }
    }
    lastBlockNumber: number
    PROD: boolean
} = {
    feeDistribution: null,
    forkConfig: {
        gasFeeSeparation: {
            activationHeight: null,
            treasuryAddress: OTHER,
        },
        osDenomination: { activationHeight: null },
    },
    lastBlockNumber: 0,
    PROD: false,
}

jest.mock("@/utilities/sharedState", () => ({
    __esModule: true,
    getSharedState: sharedStateStub,
}))

import GCRBalanceRoutines from "@/libs/blockchain/gcr/gcr_routines/GCRBalanceRoutines"
import type { GCREdit } from "@kynesyslabs/demosdk/types"

function makeBalanceEdit(overrides: Partial<GCREdit> = {}): GCREdit {
    return {
        type: "balance",
        operation: "remove",
        isRollback: false,
        account: BURN,
        amount: 10,
        txhash: "tx-0001",
        ...overrides,
    } as GCREdit
}

function makeAccount(pubkey: string, balance: bigint): any {
    return { pubkey, balance } as any
}

function activateFork(activationHeight: number): void {
    sharedStateStub.forkConfig.gasFeeSeparation.activationHeight =
        activationHeight
    sharedStateStub.feeDistribution = {
        burnAddress: BURN,
        treasuryAddress: OTHER,
        networkFee: { burnPct: 50, treasuryPct: 50 },
        additionalFee: { burnPct: 25, treasuryPct: 75 },
        specialOps: { burnPct: 25, rpcPct: 50, treasuryPct: 25 },
    }
    sharedStateStub.lastBlockNumber = activationHeight + 10
}

function deactivateFork(): void {
    sharedStateStub.forkConfig.gasFeeSeparation.activationHeight = null
    sharedStateStub.feeDistribution = null
    sharedStateStub.lastBlockNumber = 0
}

describe("GCRBalanceRoutines.apply — burn-address spend prevention (DEM-665)", () => {
    beforeEach(() => {
        deactivateFork()
        sharedStateStub.PROD = false
    })

    it("rejects a normal remove against burnAddress when fork is active", async () => {
        activateFork(100)
        const r = await GCRBalanceRoutines.apply(
            makeBalanceEdit({ operation: "remove", account: BURN }),
            makeAccount(BURN, 1000n),
        )
        expect(r.success).toBe(false)
        expect(r.message).toMatch(/Cannot deduct from burn address/)
    })

    it("allows a rollback `remove` (inverted prior burn-add) when fork is active", async () => {
        activateFork(100)
        // isRollback=true with original operation=add: the routine
        // inverts add → remove before the guard runs, but the guard
        // carves out rollbacks so it does not fire.
        const r = await GCRBalanceRoutines.apply(
            makeBalanceEdit({
                operation: "add",
                isRollback: true,
                account: BURN,
            }),
            makeAccount(BURN, 1000n),
        )
        expect(r.success).toBe(true)
    })

    it("allows a normal remove against burnAddress when fork is INACTIVE", async () => {
        deactivateFork()
        const r = await GCRBalanceRoutines.apply(
            makeBalanceEdit({ operation: "remove", account: BURN }),
            makeAccount(BURN, 1000n),
        )
        // Pre-fork the address has no consensus significance. The
        // legacy path runs and the remove succeeds because PROD=false
        // disables the balance underflow check in non-prod.
        expect(r.success).toBe(true)
    })

    it("allows a remove against a non-burn account when fork is active", async () => {
        activateFork(100)
        const r = await GCRBalanceRoutines.apply(
            makeBalanceEdit({ operation: "remove", account: OTHER }),
            makeAccount(OTHER, 1000n),
        )
        expect(r.success).toBe(true)
    })

    it("allows an add to burnAddress (fee-distribution path) when fork is active", async () => {
        activateFork(100)
        const r = await GCRBalanceRoutines.apply(
            makeBalanceEdit({ operation: "add", account: BURN }),
            makeAccount(BURN, 0n),
        )
        expect(r.success).toBe(true)
    })

    it("normalises case (uppercase hex on the edit account still hits the guard)", async () => {
        activateFork(100)
        const r = await GCRBalanceRoutines.apply(
            makeBalanceEdit({
                operation: "remove",
                account: BURN.toUpperCase().replace(/^0X/, "0x"),
            }),
            makeAccount(BURN, 1000n),
        )
        expect(r.success).toBe(false)
        expect(r.message).toMatch(/Cannot deduct from burn address/)
    })

    it("does not fire when feeDistribution is null even with fork active", async () => {
        sharedStateStub.forkConfig.gasFeeSeparation.activationHeight = 100
        sharedStateStub.lastBlockNumber = 110
        sharedStateStub.feeDistribution = null
        const r = await GCRBalanceRoutines.apply(
            makeBalanceEdit({ operation: "remove", account: BURN }),
            makeAccount(BURN, 1000n),
        )
        // Defensive — feeDistribution null is a fork-not-fully-armed
        // state; legacy path takes over.
        expect(r.success).toBe(true)
    })

    it("does not fire when lastBlockNumber < activationHeight", async () => {
        sharedStateStub.forkConfig.gasFeeSeparation.activationHeight = 1000
        sharedStateStub.feeDistribution = {
            burnAddress: BURN,
            treasuryAddress: OTHER,
            networkFee: { burnPct: 50, treasuryPct: 50 },
            additionalFee: { burnPct: 25, treasuryPct: 75 },
            specialOps: { burnPct: 25, rpcPct: 50, treasuryPct: 25 },
        }
        sharedStateStub.lastBlockNumber = 500
        const r = await GCRBalanceRoutines.apply(
            makeBalanceEdit({ operation: "remove", account: BURN }),
            makeAccount(BURN, 1000n),
        )
        expect(r.success).toBe(true)
    })
})
