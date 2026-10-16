/**
 * What the aggregation cycle sweeps out of the queue.
 *
 * A message carries no GCR edits, so its batch never produces a proof, and a
 * proof is the only thing that deletes a batched row. The sweep has to cover
 * those rows or the queue grows by one row per message, for good.
 */

import { beforeEach, describe, expect, it, jest, mock } from "bun:test"
import { mockLogger } from "@/libs/blockchain/testSupport/mockMempoolDeps"

const cleanupByStatus = jest.fn(async (..._args: unknown[]) => 0)
const cleanupBatchedWithoutEdits = jest.fn(async (..._args: unknown[]) => 0)

mock.module("@/libs/blockchain/l2ps_mempool", () => ({
    __esModule: true,
    default: { cleanupByStatus, cleanupBatchedWithoutEdits },
    L2PS_STATUS: { EXECUTED: "executed", BATCHED: "batched", CONFIRMED: "confirmed", PROCESSED: "processed" },
}))
mock.module("@/libs/l2ps/zk/L2PSBatchProver", () => ({ L2PSBatchProver: class {} }))
mock.module("@/libs/blockchain/validation/txValidatorPool", () => ({ __esModule: true, default: {} }))
mock.module("@/libs/blockchain/mempool", () => ({ __esModule: true, default: {} }))
mock.module("@/libs/l2ps/L2PSProofManager", () => ({ __esModule: true, default: {} }))
mockLogger()

const { L2PSBatchAggregator } = await import("./L2PSBatchAggregator")

beforeEach(() => {
    cleanupByStatus.mockClear()
    cleanupBatchedWithoutEdits.mockClear()
})

describe("aggregation cycle cleanup", () => {
    it("sweeps batched rows that have no edits, on every cycle", async () => {
        const aggregator = L2PSBatchAggregator.getInstance() as any
        cleanupBatchedWithoutEdits.mockResolvedValue(3)

        for (let cycle = 0; cycle < 10; cycle++) {
            await aggregator.cleanupOldBatchedTransactions()
        }

        expect(cleanupBatchedWithoutEdits).toHaveBeenCalledTimes(10)
        expect(cleanupBatchedWithoutEdits.mock.calls[0][0]).toBe(aggregator.CLEANUP_AGE_MS)
        expect(aggregator.getStatistics().cleanedUpTransactions).toBe(30)
    })
})
