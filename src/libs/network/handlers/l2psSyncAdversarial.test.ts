/**
 * Hostile paging input to the unauthenticated subnet listing.
 *
 * Anyone who can reach the node can call it, so a value that makes the table
 * read throw would turn every such call into an internal error that echoes the
 * database's own message back.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"
import { mockHandlerModules } from "./handlerMocks"

const getByUID = jest.fn(async (..._args: unknown[]) => [] as any[])
const getSubnetTransactions = jest.fn()

mockHandlerModules({ executor: { getSubnetTransactions }, mempool: { getByUID } })

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

    it.each(["abc", {}, [], NaN, Infinity, -Infinity, "1e308", null, true])(
        "a cursor or since_timestamp of %j that is not a number reads as omitted",
        async value => {
            const response = await call({ cursor: value, since_timestamp: value })

            expect(response.result).toBe(200)
            expect(lastCall()).toMatchObject({ afterId: 0, sinceMs: 0 })
        },
    )

    // The row cursor is compared with a 32-bit serial and the time cursor is
    // converted to a timestamp, so each has the bound of its own column.
    it.each([
        ["cursor", 2_147_483_647, 2_147_483_648],
        ["since_timestamp", 8.64e15, 8.64e15 + 1e3],
    ])("%s is accepted at its bound and refused one past it, before the table is read", async (field, bound, over) => {
        const ok = await call({ [field]: bound })
        expect(ok.result).toBe(200)
        expect(getSubnetTransactions).toHaveBeenCalledTimes(1)

        getSubnetTransactions.mockClear()
        for (const refused of [over, 1e308, 2 ** 53, -1, "9999999999999999"]) {
            const response = await call({ [field]: refused })
            expect(response.result).toBe(400)
        }
        expect(getSubnetTransactions).not.toHaveBeenCalled()
    })

    it("one cursor out of range refuses the call even when the other is fine", async () => {
        expect((await call({ cursor: 2_147_483_648, since_timestamp: 5 })).result).toBe(400)
        expect((await call({ cursor: 5, since_timestamp: 8.64e15 + 1e3 })).result).toBe(400)
        expect(getSubnetTransactions).not.toHaveBeenCalled()
    })

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
