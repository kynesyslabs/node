/**
 * What a peer can make the node read through the L2PS queue opcodes.
 *
 * Both opcodes are open to any connected peer. Neither may turn into a read of
 * the whole queue, whatever the peer sends or leaves out.
 */

import { beforeEach, describe, expect, it, jest, mock } from "bun:test"

const getByUID = jest.fn(async (..._args: unknown[]) => [] as unknown[])
const getPageByUID = jest.fn(async (..._args: unknown[]) => [] as unknown[])
const getSummaryByUIDAndStatus = jest.fn(async (..._args: unknown[]) => ({
    count: 777,
    oldestTimestamp: null,
    newestTimestamp: null,
}))

mock.module("@/libs/blockchain/l2ps_mempool", () => ({
    __esModule: true,
    default: { getByUID, getPageByUID, getSummaryByUIDAndStatus },
}))
mock.module("src/utilities/logger", () => ({
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

const { handleL2PSSyncMempool, handleL2PSGetBatchStatus, MAX_SYNC_MEMPOOL_ENTRIES } = await import("./l2ps")
const { encodeJsonRequest, decodeRpcResponse } = await import("../../serialization/jsonEnvelope")

async function call(handler: any, payload: unknown) {
    const reply = await handler({ message: { payload: encodeJsonRequest(payload) }, context: {} })
    return decodeRpcResponse(reply)
}

beforeEach(() => {
    getByUID.mockClear()
    getPageByUID.mockClear()
    getSummaryByUIDAndStatus.mockClear()
})

describe("L2PS_SYNC_MEMPOOL", () => {
    it("answers a request without a limit with one capped page", async () => {
        await call(handleL2PSSyncMempool, { l2psUid: "subnet_a" })

        expect(getByUID).not.toHaveBeenCalled()
        expect(getPageByUID).toHaveBeenCalledWith("subnet_a", 0, MAX_SYNC_MEMPOOL_ENTRIES)
    })

    it("caps an oversized or malformed limit and honours a smaller one", async () => {
        const asked = [5_000_000, -1, 1.5, "100000", 10]
        for (const limit of asked) {
            await call(handleL2PSSyncMempool, { l2psUid: "subnet_a", fromTimestamp: 42, limit })
        }

        const limits = getPageByUID.mock.calls.map(args => args[2])
        expect(limits).toEqual([
            MAX_SYNC_MEMPOOL_ENTRIES,
            MAX_SYNC_MEMPOOL_ENTRIES,
            MAX_SYNC_MEMPOOL_ENTRIES,
            MAX_SYNC_MEMPOOL_ENTRIES,
            10,
        ])
        expect(getPageByUID.mock.calls[0][1]).toBe(42)
    })
})

describe("L2PS_GET_BATCH_STATUS", () => {
    it("counts pending rows in the database instead of loading them", async () => {
        for (let call_ = 0; call_ < 20; call_++) {
            const reply: any = await call(handleL2PSGetBatchStatus, { l2psUid: "subnet_a" })
            expect(reply.response.pendingTransactions).toBe(777)
        }

        expect(getByUID).not.toHaveBeenCalled()
        expect(getSummaryByUIDAndStatus).toHaveBeenCalledTimes(20)
    })
})
