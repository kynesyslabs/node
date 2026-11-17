/**
 * A single transaction insert (the receipt the L2PS proof path stores per
 * block) must leave the id to the database: the raw shape carries id 0, and
 * a save that keeps it updates the row holding id 0 instead of adding one.
 */
import { beforeEach, describe, expect, it, jest } from "bun:test"

const saved: Record<string, unknown>[] = []
jest.mock("src/libs/blockchain/chainDb", () => ({
    __esModule: true,
    getBlocksRepo: jest.fn(),
    getTransactionsRepo: () => ({
        save: async (row: Record<string, unknown>) => {
            saved.push(row)
            return row
        },
    }),
    setupChainDb: jest.fn(),
    readSql: jest.fn(),
    writeSql: jest.fn(),
    maxRowsPerInsert: jest.fn(() => 1000),
    chunkedInsert: jest.fn(),
}))
jest.mock("src/libs/blockchain/mempool", () => ({ __esModule: true, default: {} }))
jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: new Proxy({}, { get: () => jest.fn() }),
}))

const { insertTransaction } = await import("./chainTransactions")

function receipt(blockNumber: number) {
    return {
        hash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
        blockNumber,
        status: "confirmed",
        signature: { type: "ed25519", data: "" },
        content: {
            type: "l2psBatch",
            from: "l2ps:consensus",
            to: "l2ps:batch",
            amount: 0,
            nonce: blockNumber,
            timestamp: 1_800_000_000_000,
            transaction_fee: { network_fee: 0, rpc_fee: 0, additional_fee: 0, rpc_address: null },
            data: ["l2psBatch", {}],
        },
    } as any
}

beforeEach(() => {
    saved.length = 0
})

describe("insertTransaction", () => {
    it("saves each receipt without an id, so two blocks' receipts are two rows", async () => {
        expect(await insertTransaction(receipt(10))).toBe(true)
        expect(await insertTransaction(receipt(11))).toBe(true)

        expect(saved).toHaveLength(2)
        for (const row of saved) expect("id" in row).toBe(false)
        expect(saved.map(r => r.hash)).toEqual([receipt(10).hash, receipt(11).hash])
    })
})
