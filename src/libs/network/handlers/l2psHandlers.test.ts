/**
 * Serving subnet history to a syncing peer.
 *
 * Rows recorded before the ciphertext was stored in `l2ps_transactions` can
 * only be served from the aggregation queue. Batching moves a queue row out of
 * "executed" long before the sweep deletes it, so the fallback has to look at
 * every status that still holds the envelope.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"
import { mockLogger } from "@/libs/blockchain/testSupport/mockMempoolDeps"

const getByUID = jest.fn(async (..._args: unknown[]) => [] as any[])
const getByOriginalHashes = jest.fn(async (..._args: unknown[]) => [] as any[])
const getSummaryByUIDAndStatus = jest.fn(async (..._args: unknown[]) => ({
    count: 0,
    oldestTimestamp: null as string | null,
    newestTimestamp: null as string | null,
}))
const getSubnetTransactions = jest.fn()

jest.mock("../../blockchain/l2ps_mempool", () => ({
    __esModule: true,
    default: { getByUID, getByOriginalHashes, getSummaryByUIDAndStatus },
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
    resolveHistoryEntry: jest.fn(),
    subnetDecryptor: jest.fn(),
}))

jest.mock("src/utilities/sharedState", () => ({ getSharedState: {} }))

mockLogger("src/utilities/logger")

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
    getByOriginalHashes.mockReset()
    getByOriginalHashes.mockResolvedValue([])
    getSummaryByUIDAndStatus.mockReset()
    getSummaryByUIDAndStatus.mockResolvedValue({ count: 0, oldestTimestamp: null, newestTimestamp: null })
    getSubnetTransactions.mockReset()
})

describe("getL2PSMempoolInfo", () => {
    it("reports the backlog from a summary, never by loading the queue", async () => {
        getSummaryByUIDAndStatus.mockResolvedValue({
            count: 250_000,
            oldestTimestamp: "1700000000000",
            newestTimestamp: "1700000900000",
        })

        // The endpoint is reachable by any peer, so repeated calls must stay cheap.
        for (let call = 0; call < 50; call++) {
            const response: any = {}
            await l2psHandlers.getL2PSMempoolInfo({ l2psUid: "subnet-1" } as any, response)
            expect(response.result).toBe(200)
            expect(response.response).toEqual({
                l2psUid: "subnet-1",
                transactionCount: 250_000,
                lastTimestamp: "1700000900000",
                oldestTimestamp: "1700000000000",
            })
        }
        expect(getByUID).not.toHaveBeenCalled()
    })

    it("reports an empty queue as zero timestamps", async () => {
        const response: any = {}
        await l2psHandlers.getL2PSMempoolInfo({ l2psUid: "subnet-1" } as any, response)

        expect(response.response.transactionCount).toBe(0)
        expect(response.response.lastTimestamp).toBe(0)
        expect(response.response.oldestTimestamp).toBe(0)
    })
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
        getByOriginalHashes.mockImplementation(
            async (_uid: unknown, hashes: unknown, statuses: unknown) =>
                queue.filter(
                    tx => (hashes as string[]).includes(tx.original_hash) && (statuses as string[]).includes(tx.status),
                ),
        )

        const response: any = {}
        await l2psHandlers.getL2PSTransactions({ l2psUid: "subnet-1" } as any, response)

        expect(response.result).toBe(200)
        expect(response.response.transactions.map((t: any) => t.encrypted_tx.hash)).toEqual([
            "enc-1",
            "enc-2",
        ])
        expect(response.response.unrecoverable).toBe(0)
        expect(getByUID).not.toHaveBeenCalled()
    })

    it("looks up only the legacy rows of the page, never the subnet's whole queue", async () => {
        getSubnetTransactions.mockResolvedValue({
            rows: [
                { ...legacyRow(1), encrypted_payload: { hash: "enc-1" } },
                legacyRow(2),
                { ...legacyRow(3), encrypted_payload: { hash: "enc-3" } },
            ],
            nextCursor: 3,
            hasMore: false,
        })

        const response: any = {}
        await l2psHandlers.getL2PSTransactions({ l2psUid: "subnet-1" } as any, response)

        expect(getByUID).not.toHaveBeenCalled()
        expect(getByOriginalHashes).toHaveBeenCalledTimes(1)
        expect(getByOriginalHashes.mock.calls[0][1]).toEqual(["orig-2"])
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
