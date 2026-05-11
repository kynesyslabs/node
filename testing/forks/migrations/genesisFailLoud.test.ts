/**
 * P-1 / myc#78 (GH#3213223279) — `subOperations.genesis()` must fail loud
 * when the legacy native-balance write rejects an over-cap value.
 *
 * Locked decision Q1: do NOT widen the legacy JSONB column to bigint.
 * `GCR.setGCRNativeBalance` already returns `false` (and logs) when the
 * incoming bigint exceeds `Number.MAX_SAFE_INTEGER`. The genesis loop
 * previously ignored that boolean, leaving the legacy GCR silently empty
 * for over-cap addresses while GCRv2 was populated correctly via
 * `chainGenesis.ts`. The bug surface: legacy backend diverges from peers.
 *
 * Fix: capture the boolean and throw on `false`. Genesis is consensus-
 * relevant — partial loads are forbidden. Refusing to start is strictly
 * safer than booting with a corrupt ledger.
 *
 * Test strategy: the heavy dependencies (TypeORM Datasource, Chain,
 * Transactions repo) make a full unit test of `genesis()` impractical.
 * Instead we (a) `mock.module()` the same modules `subOperations.ts`
 * imports BEFORE importing the subject, and (b) drive a single in-loop
 * iteration. We assert the throw fires and references the receiver.
 */

import { describe, it, expect, beforeAll, mock } from "bun:test"

// Module-level mocks must be installed before the subject is imported.
const setGCRNativeBalanceMock = mock(
    async (_address: string, _native: bigint | number, _txHash: string) =>
        false,
)

mock.module("@/libs/blockchain/gcr/gcr", () => ({
    default: {
        setGCRNativeBalance: setGCRNativeBalanceMock,
    },
    __esModule: true,
}))

// Datasource: provide enough surface for `transactionRepository.save()`.
mock.module("@/model/datasource", () => ({
    default: {
        getInstance: async () => ({
            getDataSource: () => ({
                getRepository: () => ({
                    save: async (x: unknown) => x,
                }),
            }),
        }),
    },
    __esModule: true,
}))

// Chain: only `getTransactionFromHash` is touched in genesis().
mock.module("@/libs/blockchain/chain", () => ({
    default: {
        getTransactionFromHash: async (_hash: string) => ({
            hash: "genesis_tx_hash",
            content: {
                from: "0x0",
                from_ed25519_address: "0x0",
                to: "0x0",
                timestamp: 0,
                transaction_fee: {
                    network_fee: 0,
                    rpc_fee: 0,
                    additional_fee: 0,
                },
            },
            status: "confirmed",
            ed25519_signature: "",
        }),
    },
    __esModule: true,
}))

// GCR routines and Block / Transactions / Genesis are referenced as types
// only or are not exercised by the loop we test, so default-stub them.
mock.module("@/libs/blockchain/gcr/gcr_routines", () => ({
    default: {},
    __esModule: true,
}))

// Logger is a thin sink — keep it noiseless under bun:test.
mock.module("@/utilities/logger", () => ({
    default: {
        debug: () => {},
        info: () => {},
        warning: () => {},
        warn: () => {},
        error: () => {},
    },
    __esModule: true,
}))

// Subject under test, imported AFTER the mocks above.
let subOps: typeof import("@/libs/blockchain/routines/subOperations").default

beforeAll(async () => {
    const mod = await import(
        "@/libs/blockchain/routines/subOperations"
    )
    subOps = mod.default
})

describe("subOperations.genesis fail-loud (myc#78)", () => {
    it("throws when setGCRNativeBalance returns false for any receiver", async () => {
        // Reset the mock so this test owns the call count.
        setGCRNativeBalanceMock.mockClear()
        setGCRNativeBalanceMock.mockImplementation(async () => false)

        const operation = {
            hash: "genesis_op_hash",
            params: {
                balances: [
                    ["0xRECEIVER_OVER_CAP", "1000000000000000000"], // 1e18, over cap
                ],
            },
        } as any

        const fakeBlock = {
            content: {
                ordered_transactions: ["genesis_tx_hash"],
            },
        } as any

        await expect(subOps.genesis(operation, fakeBlock)).rejects.toThrow(
            /Genesis balance load failed for receiver 0xRECEIVER_OVER_CAP/,
        )
        // The throw must mention the consensus-relevance reason.
        await expect(
            (async () => {
                setGCRNativeBalanceMock.mockImplementationOnce(async () => false)
                await subOps.genesis(operation, fakeBlock)
            })(),
        ).rejects.toThrow(/partial loads are forbidden/)
    })

    it("succeeds when every setGCRNativeBalance returns true", async () => {
        setGCRNativeBalanceMock.mockClear()
        setGCRNativeBalanceMock.mockImplementation(async () => true)

        const operation = {
            hash: "genesis_op_hash",
            params: {
                balances: [
                    ["0xA", "100"],
                    ["0xB", "200"],
                ],
            },
        } as any

        const fakeBlock = {
            content: {
                ordered_transactions: ["genesis_tx_hash"],
            },
        } as any

        const result = await subOps.genesis(operation, fakeBlock)
        expect(result.success).toBe(true)
        expect(setGCRNativeBalanceMock).toHaveBeenCalledTimes(2)
    })

    it("throws on the FIRST false and stops processing later balances", async () => {
        setGCRNativeBalanceMock.mockClear()
        // First call rejects; second would have been a poison pill.
        setGCRNativeBalanceMock
            .mockImplementationOnce(async () => false)
            .mockImplementation(async () => {
                throw new Error(
                    "must not be reached — genesis must abort on first false",
                )
            })

        const operation = {
            hash: "genesis_op_hash",
            params: {
                balances: [
                    ["0xFIRST", "1"],
                    ["0xSECOND", "2"],
                ],
            },
        } as any

        const fakeBlock = {
            content: {
                ordered_transactions: ["genesis_tx_hash"],
            },
        } as any

        await expect(subOps.genesis(operation, fakeBlock)).rejects.toThrow(
            /0xFIRST/,
        )
        expect(setGCRNativeBalanceMock).toHaveBeenCalledTimes(1)
    })
})
