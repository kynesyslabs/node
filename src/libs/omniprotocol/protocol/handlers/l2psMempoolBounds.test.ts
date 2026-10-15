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
    getPageByUID.mockReset()
    getPageByUID.mockResolvedValue([])
    getSummaryByUIDAndStatus.mockClear()
})

describe("L2PS_SYNC_MEMPOOL", () => {
    it("answers a request without a limit with one capped page", async () => {
        await call(handleL2PSSyncMempool, { l2psUid: "subnet_a" })

        expect(getByUID).not.toHaveBeenCalled()
        expect(getPageByUID).toHaveBeenCalledWith("subnet_a", { timestamp: 0, hash: undefined }, MAX_SYNC_MEMPOOL_ENTRIES + 1)
    })

    it("caps an oversized or malformed limit and honours a smaller one", async () => {
        const asked = [5_000_000, -1, 1.5, "100000", 10]
        for (const limit of asked) {
            await call(handleL2PSSyncMempool, { l2psUid: "subnet_a", fromTimestamp: 42, limit })
        }

        // One more than the page is read, to learn whether there is another.
        const limits = getPageByUID.mock.calls.map(args => args[2])
        expect(limits).toEqual([
            MAX_SYNC_MEMPOOL_ENTRIES + 1,
            MAX_SYNC_MEMPOOL_ENTRIES + 1,
            MAX_SYNC_MEMPOOL_ENTRIES + 1,
            MAX_SYNC_MEMPOOL_ENTRIES + 1,
            11,
        ])
        expect((getPageByUID.mock.calls[0][1] as any).timestamp).toBe(42)
    })

    it("pages through rows that share a millisecond without skipping or repeating any", async () => {
        // The table the query would read: ordered by (timestamp, hash).
        const table = [
            ["h1", 100], ["h2", 100], ["h3", 100], ["h4", 100], ["h5", 100], ["h6", 101], ["h7", 101],
        ].map(([hash, timestamp]) => ({
            hash, l2ps_uid: "subnet_a", original_hash: `o-${hash}`, status: "executed", timestamp: String(timestamp),
        }))
        getPageByUID.mockImplementation(async (_uid: unknown, after: any, limit: any) =>
            table
                .filter(r => Number(r.timestamp) > after.timestamp
                    || (after.hash !== undefined && Number(r.timestamp) === after.timestamp && r.hash > after.hash))
                .slice(0, limit),
        )

        const seen: string[] = []
        let cursor: { fromTimestamp: number; afterHash?: string } = { fromTimestamp: 0 }
        let pages = 0
        for (;;) {
            const reply: any = await call(handleL2PSSyncMempool, { l2psUid: "subnet_a", limit: 2, ...cursor })
            pages++
            seen.push(...reply.response.entries.map((e: any) => e.hash))
            if (!reply.response.hasMore) break
            const last = reply.response.entries.at(-1)
            cursor = { fromTimestamp: last.timestamp, afterHash: last.hash }
            expect(pages).toBeLessThan(10)
        }

        expect(seen).toEqual(["h1", "h2", "h3", "h4", "h5", "h6", "h7"])
        expect(pages).toBe(4)
    })

    it("reports hasMore only when a row exists beyond the page", async () => {
        const rows = (n: number) => Array.from({ length: n }, (_, i) => ({
            hash: `h${i}`, l2ps_uid: "subnet_a", original_hash: "o", status: "executed", timestamp: String(i + 1),
        }))
        getPageByUID.mockResolvedValueOnce(rows(3))
        expect(((await call(handleL2PSSyncMempool, { l2psUid: "subnet_a", limit: 2 })) as any).response.hasMore).toBe(true)

        getPageByUID.mockResolvedValueOnce(rows(2))
        expect(((await call(handleL2PSSyncMempool, { l2psUid: "subnet_a", limit: 2 })) as any).response.hasMore).toBe(false)
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
