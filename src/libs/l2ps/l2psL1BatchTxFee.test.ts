/**
 * The L1 batch tx the local L2PS proof path records (before l2psSettlement)
 * is stored through Transaction.toRawTransaction, which reads the fee columns
 * from content.transaction_fee. On the launch rehearsal it had none, and
 * every insert threw on transaction_fee.network_fee.
 */
import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test"

mock.module("@/utilities/logger", () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() },
}))
mock.module("@/libs/l2ps/L2PSTransactionExecutor", () => ({
    __esModule: true,
    L2PS_TX_FEE: 1,
    default: { updateTransactionStatus: async () => undefined },
}))

const { default: Chain } = await import("@/libs/blockchain/chain")
const { default: Transaction } = await import("@/libs/blockchain/transaction")
const { default: L2PSConsensus } = await import("./L2PSConsensus")

const originalInsert = Chain.insertTransaction
const stored: any[] = []

beforeEach(() => {
    stored.length = 0
    // The real insert minus the database: the row shape is what threw.
    ;(Chain as any).insertTransaction = async (tx: any) => {
        stored.push(Transaction.toRawTransaction(tx))
        return true
    }
})

afterEach(() => {
    ;(Chain as any).insertTransaction = originalInsert
})

describe("the L1 batch tx of the local L2PS proof path", () => {
    it("carries a complete zero fee and is stored", async () => {
        const proofs = [
            {
                id: 1,
                l2ps_uid: "subnet",
                transaction_count: 2,
                affected_accounts_count: 3,
                transactions_hash: "e".repeat(64),
                transaction_hashes: ["a".repeat(64), "b".repeat(64)],
            },
        ]
        const hash = await (L2PSConsensus as any).createL1BatchTransaction(proofs, 560)
        expect(hash).toMatch(/^0x[0-9a-f]{64}$/)
        expect(stored).toHaveLength(1)
        expect(stored[0]).toMatchObject({
            type: "l2psBatch",
            networkFee: 0,
            rpcFee: 0,
            additionalFee: 0,
            rpcAddress: null,
        })
    })
})
