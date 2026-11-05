/**
 * GET_MEMPOOL needs no auth, so anyone could make the node load and encode
 * its whole pool. Merge-eligible validators keep the whole pool; any other
 * caller gets the first page the nodeCall route serves.
 */

import { beforeEach, describe, expect, it, jest, mock } from "bun:test"

const STAKED = "0x" + "11".repeat(32)

const getMempool = jest.fn(async (..._args: unknown[]) => [{ hash: "a" }, { hash: "b" }] as any[])
const getMempoolPage = jest.fn(async (..._args: unknown[]) => ({ txs: [{ hash: "a" }] as any[], total: 2 }))

mock.module("src/libs/consensus/mergePeerEligibility", () => ({
    isMergePeerEligible: async (key: string) => key === STAKED,
}))
mock.module("src/libs/blockchain/mempool", () => ({
    __esModule: true,
    default: { getMempool, getMempoolPage },
}))
mock.module("../../serialization/sync", () => ({
    decodeBlockHashRequest: jest.fn(),
    decodeBlockSyncRequest: jest.fn(),
    decodeBlocksRequest: jest.fn(),
    decodeMempoolMergeRequest: jest.fn(),
    decodeMempoolSyncRequest: jest.fn(),
    decodeTransactionHashRequest: jest.fn(),
    encodeBlockResponse: jest.fn(),
    encodeBlockSyncResponse: jest.fn(),
    encodeBlocksResponse: jest.fn(),
    encodeBlockMetadata: jest.fn(),
    encodeMempoolResponse: (r: unknown) => r,
    encodeMempoolSyncResponse: jest.fn(),
}))
mock.module("../../serialization/transaction", () => ({
    decodeTransaction: jest.fn(),
    encodeTransaction: (tx: { hash: string }) => tx.hash,
    encodeTransactionEnvelope: jest.fn(),
}))

const { handleGetMempool } = await import("./sync")

const call = (context: { peerIdentity?: string; isAuthenticated?: boolean }) =>
    (handleGetMempool as any)({ message: { payload: Buffer.alloc(0) }, context })

beforeEach(() => {
    getMempool.mockClear()
    getMempoolPage.mockClear()
})

describe("handleGetMempool", () => {
    it("serves an unauthenticated caller the first page only", async () => {
        expect(await call({})).toEqual({ status: 200, transactions: ["a"] })
        expect(getMempoolPage).toHaveBeenCalledWith(0, 100)
        expect(getMempool).not.toHaveBeenCalled()
    })

    it("serves an authenticated non-validator the first page only", async () => {
        await call({ peerIdentity: "0x" + "99".repeat(32), isAuthenticated: true })
        expect(getMempoolPage).toHaveBeenCalledWith(0, 100)
        expect(getMempool).not.toHaveBeenCalled()
    })

    it("does not take an unproven identity for a validator", async () => {
        await call({ peerIdentity: STAKED, isAuthenticated: false })
        expect(getMempool).not.toHaveBeenCalled()
    })

    it("serves a merge-eligible validator the whole pool", async () => {
        expect(await call({ peerIdentity: STAKED, isAuthenticated: true })).toEqual({
            status: 200,
            transactions: ["a", "b"],
        })
        expect(getMempoolPage).not.toHaveBeenCalled()
    })
})
