/**
 * What the aggregation cycle sweeps out of the queue.
 *
 * A message carries no GCR edits, so its batch never produces a proof, and a
 * proof is the only thing that deletes a batched row. The sweep has to cover
 * those rows or the queue grows by one row per message, for good.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"

const cleanupByStatus = jest.fn(async (..._args: unknown[]) => 0)
const cleanupBatchedWithoutEdits = jest.fn(async (..._args: unknown[]) => 0)

jest.mock("@/libs/blockchain/l2ps_mempool", () => ({
    __esModule: true,
    default: { cleanupByStatus, cleanupBatchedWithoutEdits },
    L2PS_STATUS: { EXECUTED: "executed", BATCHED: "batched", CONFIRMED: "confirmed", PROCESSED: "processed" },
}))
jest.mock("@/libs/l2ps/zk/L2PSBatchProver", () => ({ L2PSBatchProver: class {} }))
jest.mock("@/libs/blockchain/validation/txValidatorPool", () => ({ __esModule: true, default: {} }))
jest.mock("@/libs/blockchain/mempool", () => ({ __esModule: true, default: {} }))
jest.mock("@/libs/l2ps/L2PSProofManager", () => ({ __esModule: true, default: {} }))
jest.mock("@/utilities/logger", () => ({
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
