/**
 * Hostile paging input to the unauthenticated subnet listing.
 *
 * Anyone who can reach the node can call it, so a value that makes the table
 * read throw would turn every such call into an internal error that echoes the
 * database's own message back.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"

const getByUID = jest.fn(async (..._args: unknown[]) => [] as any[])
const getSubnetTransactions = jest.fn()

jest.mock("../../blockchain/l2ps_mempool", () => ({
    __esModule: true,
    default: { getByUID },
    L2PS_STATUS: { EXECUTED: "executed", BATCHED: "batched", CONFIRMED: "confirmed" },
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

const { l2psHandlers } = await import("./l2psHandlers")

const call = async (data: Record<string, unknown>) => {
    const response: any = {}
    await l2psHandlers.getL2PSTransactions({ l2psUid: "subnet-1", ...data } as any, response)
    return response
}

beforeEach(() => {
    getSubnetTransactions.mockReset()
    getSubnetTransactions.mockResolvedValue({ rows: [], nextCursor: 0, hasMore: false })
})

const lastCall = () => {
    const [uid, limit, from] = getSubnetTransactions.mock.calls.at(-1) as [string, number, { afterId: number; sinceMs: number }]
    return { uid, limit, ...from }
}

describe("getL2PSTransactions, hostile paging values", () => {
    it.each([
        ["abc", 500],
        [{}, 500],
        [[3], 500],
        [NaN, 500],
        [Infinity, 500],
        [-5, 1],
        [0, 500],
        [null, 500],
        [undefined, 500],
        ["7", 7],
        [2.5, 2],
        [1e9, 1000],
        [1e308, 1000],
        [true, 500],
    ])("limit %j reaches the table as %p (500 is the default)", async (limit, applied) => {
        const response = await call({ limit })

        expect(response.result).toBe(200)
        expect(lastCall().limit).toBe(applied)
    })

    it.each([-1, "abc", {}, [], NaN, Infinity, -Infinity, 1e308, "1e308", 2 ** 53, null, true])(
        "cursor %j and since_timestamp %j reach the table as safe, non-negative whole numbers",
        async value => {
            const response = await call({ cursor: value, since_timestamp: value })

            expect(response.result).toBe(200)
            const { afterId, sinceMs } = lastCall()
            for (const n of [afterId, sinceMs]) {
                expect(Number.isSafeInteger(n)).toBe(true)
                expect(n).toBeGreaterThanOrEqual(0)
            }
        },
    )

    it.each([[{}], [["a"]], [5], [true]])("a subnet of %j is refused before the table is read", async uid => {
        const response = await call({ l2psUid: uid })

        expect(response.result).toBe(400)
        expect(getSubnetTransactions).not.toHaveBeenCalled()
    })

    it("does not echo a table error to an unauthenticated caller", async () => {
        getSubnetTransactions.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.3.7:5432 user=demos"))
        const response = await call({})

        expect(response.result).toBe(500)
        expect(JSON.stringify(response)).not.toContain("10.0.3.7")
    })
})

describe("the other subnet queries refuse a subnet that is not a string", () => {
    it.each([[{}], [["a"]], [5], [true]])("%j", async uid => {
        for (const name of ["getL2PSMempoolInfo", "getL2PSParticipationById"] as const) {
            getByUID.mockClear()
            const response: any = {}
            await l2psHandlers[name]({ l2psUid: uid } as any, response)

            expect(response.result).toBe(400)
            expect(getByUID).not.toHaveBeenCalled()
        }
    })
})
