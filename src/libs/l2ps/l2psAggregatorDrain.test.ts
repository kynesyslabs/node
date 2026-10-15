/**
 * How much of a subnet's executed queue one aggregation cycle drains.
 *
 * A batch holds at most ten transactions (the ZK circuit size), so building one
 * batch per cycle capped the drain at ten transactions per interval.
 */

import { beforeEach, describe, expect, it, jest, mock } from "bun:test"

const executed = Array.from({ length: 50 }, (_, i) => ({
    hash: `0x${i.toString().padStart(4, "0")}`,
    l2ps_uid: "subnet_a",
    original_hash: `orig-${i}`,
    encrypted_tx: {},
    status: "executed",
    timestamp: String(1_700_000_000_000 + i),
    gcr_edits: null,
}))

const getByStatus = jest.fn(async (_status: unknown, limit?: number) => executed.slice(0, limit))
const updateStatusBatch = jest.fn(async (hashes: string[]) => hashes.length)

mock.module("@/libs/blockchain/l2ps_mempool", () => ({
    __esModule: true,
    default: { getByStatus, updateStatusBatch, cleanupByStatus: async () => 0 },
    L2PS_STATUS: { EXECUTED: "executed", BATCHED: "batched", CONFIRMED: "confirmed", PROCESSED: "processed" },
}))
mock.module("@/libs/l2ps/zk/L2PSBatchProver", () => ({ L2PSBatchProver: class {} }))
mock.module("@/libs/blockchain/validation/txValidatorPool", () => ({ __esModule: true, default: {} }))
mock.module("@/libs/blockchain/mempool", () => ({ __esModule: true, default: {} }))
mock.module("@/libs/l2ps/L2PSProofManager", () => ({ __esModule: true, default: {} }))
mock.module("@/libs/l2ps/L2PSTransactionExecutor", () => ({
    __esModule: true,
    L2PS_TX_FEE: 1,
    default: { updateTransactionStatus: async () => undefined },
}))
mock.module("@/utilities/logger", () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() },
}))

const { L2PSBatchAggregator } = await import("./L2PSBatchAggregator")
const aggregator = L2PSBatchAggregator.getInstance() as any

const createBatchPayload = jest.spyOn(aggregator, "createBatchPayload")
const submitBatchToMempool = jest.spyOn(aggregator, "submitBatchToMempool")

beforeEach(() => {
    getByStatus.mockClear()
    updateStatusBatch.mockClear()
    createBatchPayload.mockReset()
    submitBatchToMempool.mockReset()
    createBatchPayload.mockImplementation(async (uid: string, txs: any[]) => ({
        l2ps_uid: uid,
        transaction_count: txs.length,
        batch_hash: `batch-${txs[0].hash}`,
    }))
    submitBatchToMempool.mockResolvedValue(true)
    aggregator.MAX_BATCHES_PER_CYCLE = 5
})

describe("aggregation cycle drain", () => {
    it("builds five batches of ten from fifty executed rows with the default", async () => {
        await aggregator.aggregateAndSubmitBatches()

        expect(submitBatchToMempool).toHaveBeenCalledTimes(5)
        expect(updateStatusBatch.mock.calls.map(([hashes]) => hashes.length)).toEqual([10, 10, 10, 10, 10])
        const batched = updateStatusBatch.mock.calls.flatMap(([hashes]) => hashes)
        expect(new Set(batched).size).toBe(50)
    })

    it("keeps to the configured number of batches per cycle", async () => {
        aggregator.MAX_BATCHES_PER_CYCLE = 2
        await aggregator.aggregateAndSubmitBatches()

        expect(submitBatchToMempool).toHaveBeenCalledTimes(2)
    })

    it("stops a subnet's cycle at the first batch that fails to submit", async () => {
        submitBatchToMempool.mockResolvedValue(false)
        await aggregator.aggregateAndSubmitBatches()

        expect(submitBatchToMempool).toHaveBeenCalledTimes(1)
        expect(updateStatusBatch).not.toHaveBeenCalled()
    })
})
