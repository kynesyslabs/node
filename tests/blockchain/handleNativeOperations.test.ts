/**
 * DEM-665 — handleNativeOperations.ts TLSN fork-gating tests.
 *
 * Covers the post-fork branch added in P7: tlsn_request and tlsn_store
 * route their fee through generateSpecialOpsFeeEdits when the fork is
 * active, and through the legacy single-remove burn when it isn't.
 *
 * Mocks tokenManager so the test does not depend on an actual TLSN
 * token store and can exercise tlsn_store without standing one up.
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
const TREASURY = "0x" + "11".repeat(32)
const SENDER = "0x" + "aa".repeat(32)
const RPC = "0x" + "bb".repeat(32)

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
            treasuryAddress: TREASURY,
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

// Mock TLSN tokenManager so tlsn_store can run without a live token
// store. The token shape mirrors the real entity just enough for the
// handler's checks.
jest.mock("@/features/tlsnotary/tokenManager", () => ({
    __esModule: true,
    extractDomain: jest.fn((u: string) => new URL(u).hostname),
    getToken: jest.fn(() => ({
        owner: SENDER,
        domain: "example.com",
        status: "active",
    })),
    markStored: jest.fn(),
    TokenStatus: {
        COMPLETED: "completed",
        ACTIVE: "active",
    },
}))

import { HandleNativeOperations } from "@/libs/blockchain/gcr/gcr_routines/handleNativeOperations"

function activateFork(activationHeight: number): void {
    sharedStateStub.forkConfig.gasFeeSeparation.activationHeight =
        activationHeight
    sharedStateStub.feeDistribution = {
        burnAddress: BURN,
        treasuryAddress: TREASURY,
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

function makeTlsnRequestTx(rpcAddress: string | null = RPC): any {
    return {
        hash: "tx-tlsn-req",
        blockNumber: sharedStateStub.lastBlockNumber || 0,
        content: {
            type: "native",
            from: SENDER,
            transaction_fee: {
                network_fee: 0,
                rpc_fee: 0,
                additional_fee: 0,
                rpc_address: rpcAddress,
            },
            data: [
                "native",
                {
                    nativeOperation: "tlsn_request",
                    args: ["https://example.com/api"],
                },
            ],
        },
    }
}

function makeTlsnStoreTx(): any {
    return {
        hash: "tx-tlsn-store",
        blockNumber: sharedStateStub.lastBlockNumber || 0,
        content: {
            type: "native",
            from: SENDER,
            transaction_fee: {
                network_fee: 0,
                rpc_fee: 0,
                additional_fee: 0,
                rpc_address: RPC,
            },
            data: [
                "native",
                {
                    nativeOperation: "tlsn_store",
                    args: ["tok-1", "x".repeat(2048), "onchain"],
                },
            ],
        },
    }
}

describe("handleNativeOperations — tlsn_request fork-gating (DEM-665)", () => {
    beforeEach(() => {
        deactivateFork()
        sharedStateStub.PROD = false
    })

    it("pre-fork: emits a single remove for the legacy 1-DEM burn", async () => {
        const edits = await HandleNativeOperations.handle(makeTlsnRequestTx())
        const balanceEdits = edits.filter(e => e.type === "balance") as any[]
        expect(balanceEdits).toHaveLength(1)
        expect(balanceEdits[0].operation).toBe("remove")
        expect(balanceEdits[0].account).toBe(SENDER)
        expect(balanceEdits[0].amount).toBe(1)
    })

    it("post-fork: emits 25/50/25 special-ops split scaled to OS (4 edits)", async () => {
        activateFork(100)
        const tx = makeTlsnRequestTx()
        const edits = await HandleNativeOperations.handle(tx)
        const balanceEdits = edits.filter(e => e.type === "balance") as any[]
        expect(balanceEdits).toHaveLength(4)
        // Total fee = 1 DEM × 10^9 = 1_000_000_000 OS
        expect(
            balanceEdits.find(
                e => e.operation === "remove" && e.account === SENDER,
            )?.amount,
        ).toBe(1_000_000_000)
        // 25% burn = 250_000_000
        expect(
            balanceEdits.find(e => e.account === BURN)?.amount,
        ).toBe(250_000_000)
        // 50% rpc = 500_000_000
        expect(
            balanceEdits.find(e => e.account === RPC)?.amount,
        ).toBe(500_000_000)
        // 25% treasury (remainder) = 250_000_000
        expect(
            balanceEdits.find(e => e.account === TREASURY)?.amount,
        ).toBe(250_000_000)
    })

    it("post-fork: folds rpc share into treasury when rpcAddress is null", async () => {
        activateFork(100)
        const edits = await HandleNativeOperations.handle(
            makeTlsnRequestTx(null),
        )
        const balanceEdits = edits.filter(e => e.type === "balance") as any[]
        // remove + burn + treasury (rpc merged into treasury) = 3 edits
        expect(balanceEdits).toHaveLength(3)
        expect(
            balanceEdits.find(e => e.account === TREASURY)?.amount,
        ).toBe(750_000_000)
    })

    // PR #817 Greptile P1 (G-1): silent fee bypass. If feeDistribution
    // is not primed (or all-zero) when tlsn_request lands post-fork,
    // generateSpecialOpsFeeEdits returns []. Without the guard the tx
    // would proceed with zero fee collection. Verify the throw.
    it("post-fork: throws when feeDistribution is unprimed (no silent bypass)", async () => {
        activateFork(100)
        sharedStateStub.feeDistribution = null
        await expect(
            HandleNativeOperations.handle(makeTlsnRequestTx()),
        ).rejects.toThrow(/fee distribution not primed/)
    })
})

describe("handleNativeOperations — tlsn_store fork-gating (DEM-665)", () => {
    beforeEach(() => {
        deactivateFork()
        sharedStateStub.PROD = false
    })

    it("pre-fork: legacy single remove with size-based fee", async () => {
        const edits = await HandleNativeOperations.handle(makeTlsnStoreTx())
        // 2048 bytes => 2 KB => storeBase(1) + 2 * storePerKb(1) = 3
        const balanceEdits = edits.filter(e => e.type === "balance") as any[]
        expect(balanceEdits).toHaveLength(1)
        expect(balanceEdits[0].operation).toBe("remove")
        expect(balanceEdits[0].amount).toBe(3)
    })

    // PR #817 Greptile P1 (G-2): same silent-bypass guard as
    // tlsn_request, applied to tlsn_store.
    it("post-fork: throws when feeDistribution is unprimed (no silent bypass)", async () => {
        activateFork(100)
        sharedStateStub.feeDistribution = null
        await expect(
            HandleNativeOperations.handle(makeTlsnStoreTx()),
        ).rejects.toThrow(/fee distribution not primed/)
    })

    it("post-fork: size-scaled fee split via special-ops distribution", async () => {
        activateFork(100)
        const edits = await HandleNativeOperations.handle(makeTlsnStoreTx())
        // 3 DEM × 10^9 = 3_000_000_000 OS total
        const balanceEdits = edits.filter(e => e.type === "balance") as any[]
        expect(balanceEdits).toHaveLength(4)
        const removed = balanceEdits.find(
            e => e.operation === "remove" && e.account === SENDER,
        )?.amount as number
        const added = balanceEdits
            .filter(e => e.operation === "add")
            .reduce((s, e) => s + (e.amount as number), 0)
        expect(removed).toBe(3_000_000_000)
        expect(added).toBe(removed) // sum invariant
        // 25% burn / 50% rpc / 25% treasury — exact math because 3e9
        // splits cleanly under integer division.
        expect(
            balanceEdits.find(e => e.account === BURN)?.amount,
        ).toBe(750_000_000)
        expect(
            balanceEdits.find(e => e.account === RPC)?.amount,
        ).toBe(1_500_000_000)
        expect(
            balanceEdits.find(e => e.account === TREASURY)?.amount,
        ).toBe(750_000_000)
    })
})
