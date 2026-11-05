/**
 * The public mempool read serves one bounded page with the pool size, so a
 * client cannot make the node load and serialise up to the whole pool on
 * every call. The consensus routes read the pool directly and are not
 * covered here.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"

const getMempool = jest.fn(async (..._args: unknown[]) => [] as any[])
const getMempoolPage = jest.fn(async (..._args: unknown[]) => ({ txs: [] as any[], total: 0 }))

jest.mock("../../blockchain/chain", () => ({ __esModule: true, default: {} }))
jest.mock("../routines/nodecalls/getTransactions", () => ({ __esModule: true, default: jest.fn() }))
jest.mock("../routines/nodecalls/getTransactionStatus", () => ({ __esModule: true, default: jest.fn() }))
jest.mock("../routines/nodecalls/getTransactionProof", () => ({ __esModule: true, default: jest.fn() }))
jest.mock("../routines/nodecalls/getTxsByHashes", () => ({ __esModule: true, default: jest.fn() }))
jest.mock("../../blockchain/mempool", () => ({ __esModule: true, default: { getMempool, getMempoolPage } }))
jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() },
}))

const { transactionHandlers } = await import("./transactionHandlers")

async function mempool(data: unknown) {
    const response: any = { result: 200, response: null, require_reply: false, extra: null }
    return transactionHandlers.getMempool(data as any, response)
}

beforeEach(() => {
    getMempool.mockReset()
    getMempoolPage.mockReset()
    getMempoolPage.mockResolvedValue({ txs: [{ hash: "0x1" }], total: 4321 })
})

describe("getMempool nodeCall", () => {
    it("serves the first 100 by default and reports the pool size", async () => {
        const reply = await mempool({})
        expect(getMempoolPage).toHaveBeenCalledWith(0, 100)
        expect(getMempool).not.toHaveBeenCalled()
        expect(reply.result).toBe(200)
        expect(reply.response).toEqual([{ hash: "0x1" }])
        expect(reply.extra).toEqual({ total: 4321, start: 0, limit: 100 })
    })

    it("treats missing data like an empty request", async () => {
        await mempool(undefined)
        expect(getMempoolPage).toHaveBeenCalledWith(0, 100)
    })

    it("caps a larger page at 100 and passes an offset through", async () => {
        await mempool({ start: 200, limit: 10_000 })
        await mempool({ start: "5", limit: "20" })
        expect(getMempoolPage.mock.calls).toEqual([
            [200, 100],
            [5, 20],
        ])
    })

    it("refuses a negative, fractional or non-numeric start or limit", async () => {
        for (const bad of [{ start: -1 }, { limit: -1 }, { limit: 2.5 }, { start: "-5" }, { limit: "all" }]) {
            const reply = await mempool(bad)
            expect(reply.result).toBe(400)
        }
        expect(getMempoolPage).not.toHaveBeenCalled()
    })
})
