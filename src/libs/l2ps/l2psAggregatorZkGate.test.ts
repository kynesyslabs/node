/**
 * The image ships the L2PS proving keys, so key presence must not turn proving
 * on: only L2PS_ZK_ENABLED=true starts the prover subprocess.
 */

import { afterEach, describe, expect, it, jest, mock } from "bun:test"

const initialize = jest.fn<() => Promise<void>>(async () => undefined)
const constructed = jest.fn()
const terminate = jest.fn(async () => undefined)
mock.module("@/libs/l2ps/zk/L2PSBatchProver", () => ({
    L2PSBatchProver: class {
        constructor() {
            constructed()
        }
        initialize = initialize
        terminate = terminate
    },
}))
mock.module("@/libs/blockchain/l2ps_mempool", () => ({
    __esModule: true,
    default: { getExecutedSubnets: async () => [], cleanupByStatus: async () => 0 },
    L2PS_STATUS: { EXECUTED: "executed", BATCHED: "batched", CONFIRMED: "confirmed", PROCESSED: "processed" },
}))
mock.module("@/libs/blockchain/validation/txValidatorPool", () => ({ __esModule: true, default: {} }))
mock.module("@/libs/blockchain/mempool", () => ({ __esModule: true, default: {} }))
mock.module("@/libs/l2ps/L2PSProofManager", () => ({ __esModule: true, default: {} }))
mock.module("@/libs/l2ps/L2PSTransactionExecutor", () => ({
    __esModule: true,
    L2PS_TX_FEE: 1,
    default: { updateTransactionStatus: async () => undefined, scrubStoredPlaintext: async () => 0 },
}))
mock.module("@/utilities/logger", () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() },
}))

const { L2PSBatchAggregator } = await import("./L2PSBatchAggregator")
const aggregator = L2PSBatchAggregator.getInstance() as any

afterEach(async () => {
    await aggregator.stop()
    constructed.mockClear()
    initialize.mockClear()
    terminate.mockClear()
})

describe("L2PS batch proofs gate", () => {
    it("is off by default and never starts the prover", async () => {
        aggregator.zkRequested = false
        await aggregator.start()
        expect(constructed).not.toHaveBeenCalled()
        expect(aggregator.zkProver).toBeNull()
    })

    it("starts the prover when enabled", async () => {
        aggregator.zkRequested = true
        await aggregator.start()
        expect(constructed).toHaveBeenCalledTimes(1)
        expect(initialize).toHaveBeenCalledTimes(1)
        expect(aggregator.zkEnabled).toBe(true)
        await aggregator.stop()
        expect(terminate).toHaveBeenCalledTimes(1)
        expect(aggregator.zkProver).toBeNull()
    })

    it("retries a failed prover setup on the next start", async () => {
        aggregator.zkRequested = true
        initialize.mockImplementationOnce(async () => {
            throw new Error("keys missing")
        })
        await aggregator.start()
        expect(aggregator.zkEnabled).toBe(false)
        await aggregator.stop()
        await aggregator.start()
        expect(initialize).toHaveBeenCalledTimes(2)
        expect(aggregator.zkEnabled).toBe(true)
    })
})
