/**
 * getTxByHash has to tell "not in this chain as of height H" apart from
 * "could not look": a client recovering a lost broadcast reply keeps waiting
 * on the first and asks another node on the second.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"

const getTxByHash = jest.fn(async (..._args: unknown[]) => null as any)
const getLastBlockNumber = jest.fn(async () => 4242)

jest.mock("../../blockchain/chain", () => ({ __esModule: true, default: { getTxByHash, getLastBlockNumber } }))
jest.mock("../routines/nodecalls/getTransactions", () => ({ __esModule: true, default: jest.fn() }))
jest.mock("../routines/nodecalls/getTransactionStatus", () => ({ __esModule: true, default: jest.fn() }))
jest.mock("../routines/nodecalls/getTxsByHashes", () => ({ __esModule: true, default: jest.fn() }))
jest.mock("../../blockchain/mempool", () => ({ __esModule: true, default: {} }))
jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() },
}))

const { transactionHandlers } = await import("./transactionHandlers")

async function lookup(data: Record<string, unknown>) {
    const response: any = { result: 200, response: null, require_reply: false, extra: null }
    return transactionHandlers.getTxByHash(data as any, response)
}

beforeEach(() => {
    getTxByHash.mockReset()
    getLastBlockNumber.mockReset()
    getLastBlockNumber.mockResolvedValue(4242)
})

describe("getTxByHash", () => {
    it("returns a stored transaction", async () => {
        const tx = { hash: "0xabc", blockNumber: 4200 }
        getTxByHash.mockResolvedValue(tx)

        const reply = await lookup({ hash: "0xabc" })

        expect(reply.result).toBe(200)
        expect(reply.response).toBe(tx)
    })

    it("answers not found with the height it searched through", async () => {
        const reply = await lookup({ hash: "0xmissing" })

        expect(reply.result).toBe(404)
        expect(reply.response).toBeNull()
        expect(reply.extra).toEqual({ reason: "not_found", checkedThroughBlock: 4242 })
    })

    it("answers a failed lookup as such, with the error as text", async () => {
        getTxByHash.mockRejectedValue(new Error("connection terminated"))

        const reply = await lookup({ hash: "0xabc" })

        expect(reply.result).toBe(500)
        expect(reply.response).toBeNull()
        expect(reply.extra).toEqual({ reason: "lookup_failed", error: "connection terminated" })
    })

    it("reads the height before the lookup, so the claim covers it", async () => {
        const order: string[] = []
        getLastBlockNumber.mockImplementation(async () => {
            order.push("height")
            return 7
        })
        getTxByHash.mockImplementation(async () => {
            order.push("lookup")
            return null
        })

        await lookup({ hash: "0xabc" })

        expect(order).toEqual(["height", "lookup"])
    })

    it("still refuses a request without a hash", async () => {
        const reply = await lookup({})

        expect(reply.result).toBe(400)
        expect(reply.response).toBe("No hash specified")
    })
})
