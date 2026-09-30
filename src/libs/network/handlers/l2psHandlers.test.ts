/**
 * Serving subnet history to a syncing peer.
 *
 * Rows recorded before the ciphertext was stored in `l2ps_transactions` can
 * only be served from the aggregation queue. Batching moves a queue row out of
 * "executed" long before the sweep deletes it, so the fallback has to look at
 * every status that still holds the envelope.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"

const getByUID = jest.fn(async (..._args: unknown[]) => [] as any[])
const getSubnetTransactions = jest.fn()

jest.mock("../../blockchain/l2ps_mempool", () => ({
    __esModule: true,
    default: { getByUID },
    L2PS_STATUS: {
        PENDING: "pending",
        PROCESSED: "processed",
        EXECUTED: "executed",
        FAILED: "failed",
        BATCHED: "batched",
        CONFIRMED: "confirmed",
    },
}))

jest.mock("../../l2ps/L2PSTransactionExecutor", () => ({
    __esModule: true,
    default: { getSubnetTransactions },
}))

jest.mock("@/libs/l2ps/historyPayload", () => ({
    resolveHistoryMessage: jest.fn(),
    subnetDecryptor: jest.fn(),
}))

jest.mock("src/utilities/sharedState", () => ({ getSharedState: {} }))

jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        only: jest.fn(),
    },
}))

// Imported once the mocks are registered: a static import is evaluated first,
// loads the real mempool, and cycles back through the handler index.
const { l2psHandlers } = await import("./l2psHandlers")

const legacyRow = (id: number) => ({
    id,
    hash: `orig-${id}`,
    encrypted_hash: `enc-${id}`,
    l2ps_uid: "subnet-1",
    encrypted_payload: null,
    timestamp: "1",
    l1_block_number: null,
})

beforeEach(() => {
    getByUID.mockReset()
    getSubnetTransactions.mockReset()
})

describe("getL2PSTransactions", () => {
    it("recovers a legacy row's ciphertext from the queue after it has been batched", async () => {
        getSubnetTransactions.mockResolvedValue({
            rows: [legacyRow(1), legacyRow(2)],
            nextCursor: 2,
            hasMore: false,
        })
        const queue = [
            { original_hash: "orig-1", status: "batched", encrypted_tx: { hash: "enc-1" } },
            { original_hash: "orig-2", status: "confirmed", encrypted_tx: { hash: "enc-2" } },
        ]
        getByUID.mockImplementation(async (_uid: unknown, status: unknown) => {
            const wanted = Array.isArray(status) ? status : [status]
            return queue.filter(tx => wanted.includes(tx.status))
        })

        const response: any = {}
        await l2psHandlers.getL2PSTransactions({ l2psUid: "subnet-1" } as any, response)

        expect(response.result).toBe(200)
        expect(response.response.transactions.map((t: any) => t.encrypted_tx.hash)).toEqual([
            "enc-1",
            "enc-2",
        ])
        expect(response.response.unrecoverable).toBe(0)
    })

    it("does not touch the queue when every row carries its ciphertext", async () => {
        getSubnetTransactions.mockResolvedValue({
            rows: [{ ...legacyRow(1), encrypted_payload: { hash: "enc-1" } }],
            nextCursor: 1,
            hasMore: false,
        })

        const response: any = {}
        await l2psHandlers.getL2PSTransactions({ l2psUid: "subnet-1" } as any, response)

        expect(response.response.transactions).toHaveLength(1)
        expect(getByUID).not.toHaveBeenCalled()
    })
})
