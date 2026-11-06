/**
 * getTxsByHashes serves mempool transactions to peers that are syncing a block
 * this node has not applied yet, stamped with the latest block number. A reader
 * of the public nodeCall must be able to tell those apart from included ones.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"

const getTransactionsFromHashes = jest.fn(async (..._args: unknown[]) => [] as any[])
const getTransactionsByHashes = jest.fn(async (..._args: unknown[]) => [] as any[])
const sharedState = { lastBlockNumber: 4242, batchSyncTxLimit: 100 }

jest.mock("src/libs/blockchain/chain", () => ({ __esModule: true, default: { getTransactionsFromHashes } }))
jest.mock("@/libs/blockchain/mempool", () => ({ __esModule: true, default: { getTransactionsByHashes } }))
jest.mock("@/utilities/sharedState", () => ({ getSharedState: sharedState }))
jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() },
}))

const { default: getTxsByHashes } = await import("./getTxsByHashes")

beforeEach(() => {
    getTransactionsFromHashes.mockReset()
    getTransactionsByHashes.mockReset()
    getTransactionsFromHashes.mockResolvedValue([])
    getTransactionsByHashes.mockResolvedValue([])
    sharedState.lastBlockNumber = 4242
})

describe("getTxsByHashes", () => {
    it("serves a mempool transaction at the latest block number", async () => {
        getTransactionsByHashes.mockResolvedValue([{ hash: "0xpending", content: { nonce: 1 } }])

        const reply = await getTxsByHashes({ hashes: ["0xpending"] })

        expect(reply.result).toBe(200)
        expect(reply.response).toHaveLength(1)
        expect(reply.response[0].hash).toBe("0xpending")
        expect(reply.response[0].blockNumber).toBe(4242)
    })

    it("marks a mempool transaction as pending", async () => {
        getTransactionsByHashes.mockResolvedValue([{ hash: "0xpending", content: { nonce: 1 } }])

        const reply = await getTxsByHashes({ hashes: ["0xpending"] })

        expect(reply.response[0].pending).toBe(true)
    })

    it("does not mark a stored transaction as pending", async () => {
        getTransactionsFromHashes.mockResolvedValue([{ hash: "0xstored", blockNumber: 4200 }])

        const reply = await getTxsByHashes({ hashes: ["0xstored"] })

        expect(reply.response).toEqual([{ hash: "0xstored", blockNumber: 4200 }])
        expect(getTransactionsByHashes).not.toHaveBeenCalled()
    })

    it("marks only the mempool part of a mixed request", async () => {
        getTransactionsFromHashes.mockResolvedValue([{ hash: "0xstored", blockNumber: 4200 }])
        getTransactionsByHashes.mockResolvedValue([{ hash: "0xpending" }])

        const reply = await getTxsByHashes({ hashes: ["0xstored", "0xpending"] })

        expect(getTransactionsByHashes).toHaveBeenCalledWith(["0xpending"])
        const byHash = Object.fromEntries(reply.response.map((tx: any) => [tx.hash, tx]))
        expect(byHash["0xstored"].pending).toBeUndefined()
        expect(byHash["0xstored"].blockNumber).toBe(4200)
        expect(byHash["0xpending"].pending).toBe(true)
        expect(byHash["0xpending"].blockNumber).toBe(4242)
    })
})
