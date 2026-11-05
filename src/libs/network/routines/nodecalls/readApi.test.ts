/**
 * Client read calls: a status answer that says how far the node searched and
 * why it found nothing, block 0 as a valid height, transaction pages that
 * serialise, and a bounded history page.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"

const getTransactionStatus = jest.fn(async (..._args: unknown[]) => ({ state: "unknown" }) as any)
const getLastBlockNumber = jest.fn(async () => 4242)
const getGenesisBlockHash = jest.fn(async () => "83082fbb")
const getBlockByNumber = jest.fn(async (..._args: unknown[]) => null as any)
const getTransactions = jest.fn(async (..._args: unknown[]) => [] as any[])
const getTransactionHistory = jest.fn(async (..._args: unknown[]) => [] as any[])
const sharedState: { syncStatus: boolean; inSyncLoop: boolean; forkConfig?: unknown } = { syncStatus: true, inSyncLoop: false }

jest.mock("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getTransactionStatus, getLastBlockNumber, getGenesisBlockHash, getBlockByNumber, getTransactions, getTransactionHistory },
}))
jest.mock("src/utilities/sharedState", () => ({ __esModule: true, getSharedState: sharedState }))
jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() },
}))

const { default: getTransactionStatusCall } = await import("./getTransactionStatus")
const { default: getBlockByNumberCall } = await import("./getBlockByNumber")
const { default: getTransactionsCall } = await import("./getTransactions")

const HASH = "85b8fcdcee48822742a39e1b9877f5e2f8dde36430e8e486e3a8b0c9a7744cbd"

beforeEach(() => {
    for (const fn of [getTransactionStatus, getLastBlockNumber, getBlockByNumber, getTransactions, getTransactionHistory]) fn.mockReset()
    getLastBlockNumber.mockResolvedValue(4242)
    getTransactionStatus.mockResolvedValue({ state: "unknown" })
    getTransactions.mockResolvedValue([])
    getTransactionHistory.mockResolvedValue([])
    sharedState.syncStatus = true
    sharedState.inSyncLoop = false
    sharedState.forkConfig = undefined
})

describe("getTransactionStatus", () => {
    it("answers a failed transaction with its code and the height searched", async () => {
        getTransactionStatus.mockResolvedValue({ state: "failed", blockNumber: 480877, code: "TX_NONCE_INVALID_LOW", message: "Nonce too low" })
        const reply = await getTransactionStatusCall({ hash: HASH })
        expect(reply.result).toBe(200)
        expect(reply.response).toEqual({
            state: "failed",
            blockNumber: 480877,
            code: "TX_NONCE_INVALID_LOW",
            message: "Nonce too low",
            checkedThroughBlock: 4242,
        })
    })

    it("answers an executed one as included", async () => {
        getTransactionStatus.mockResolvedValue({ state: "included", blockNumber: 4200 })
        const reply = await getTransactionStatusCall({ hash: HASH })
        expect(reply.result).toBe(200)
        expect(reply.response).toEqual({ state: "included", blockNumber: 4200, checkedThroughBlock: 4242 })
    })

    it("answers a hash it does not hold with 404, keeping the state in the body for polling clients", async () => {
        const reply = await getTransactionStatusCall({ hash: HASH })
        expect(reply.result).toBe(404)
        expect(reply.response).toEqual({ state: "unknown", checkedThroughBlock: 4242 })
        expect(reply.extra).toEqual({ reason: "not_found" })
    })

    it("answers 503 instead while the node is behind", async () => {
        sharedState.syncStatus = false
        const reply = await getTransactionStatusCall({ hash: HASH })
        expect(reply.result).toBe(503)
        expect(reply.response).toEqual({ state: "unknown", checkedThroughBlock: 4242 })
        expect(reply.extra).toEqual({ reason: "node_not_synced" })
    })

    it("keeps answering 404 during the sync pass every round starts with", async () => {
        sharedState.inSyncLoop = true
        expect((await getTransactionStatusCall({ hash: HASH })).result).toBe(404)
    })

    it("still answers a found transaction while syncing", async () => {
        sharedState.syncStatus = false
        getTransactionStatus.mockResolvedValue({ state: "included", blockNumber: 10 })
        expect((await getTransactionStatusCall({ hash: HASH })).result).toBe(200)
    })

    it("answers a failed lookup as 500 lookup_failed, never as not found", async () => {
        getTransactionStatus.mockRejectedValue(new Error("connection terminated"))
        const reply = await getTransactionStatusCall({ hash: HASH })
        expect(reply.result).toBe(500)
        expect(reply.extra).toEqual({ reason: "lookup_failed", error: "connection terminated" })
    })

    it("reads the height before the lookup, so the claim covers it", async () => {
        const order: string[] = []
        getLastBlockNumber.mockImplementation(async () => {
            order.push("height")
            return 7
        })
        getTransactionStatus.mockImplementation(async () => {
            order.push("lookup")
            return { state: "unknown" }
        })
        await getTransactionStatusCall({ hash: HASH })
        expect(order).toEqual(["height", "lookup"])
    })

    it("refuses a malformed hash", async () => {
        expect((await getTransactionStatusCall({ hash: "0x12" })).result).toBe(400)
        expect(getTransactionStatus).not.toHaveBeenCalled()
    })

    describe("under finalityProofs", () => {
        beforeEach(() => {
            sharedState.forkConfig = { finalityProofs: { activationHeight: 0 } }
        })

        it("names the block that commits the result once it is within the height searched", async () => {
            getTransactionStatus.mockResolvedValue({ state: "failed", blockNumber: 4200, code: "TX_NONCE_INVALID_LOW" })
            const reply = await getTransactionStatusCall({ hash: HASH })
            expect(reply.response).toEqual({
                state: "failed",
                blockNumber: 4200,
                code: "TX_NONCE_INVALID_LOW",
                resultCommittedInBlock: 4201,
                checkedThroughBlock: 4242,
            })
        })

        it("answers null until the next block exists", async () => {
            getTransactionStatus.mockResolvedValue({ state: "included", blockNumber: 4242 })
            expect((await getTransactionStatusCall({ hash: HASH })).response.resultCommittedInBlock).toBeNull()
        })

        it("leaves it out where no block commits the result: genesis, pending and before the fork", async () => {
            getTransactionStatus.mockResolvedValue({ state: "included", blockNumber: 0 })
            expect((await getTransactionStatusCall({ hash: HASH })).response).not.toHaveProperty("resultCommittedInBlock")
            getTransactionStatus.mockResolvedValue({ state: "pending" })
            expect((await getTransactionStatusCall({ hash: HASH })).response).not.toHaveProperty("resultCommittedInBlock")
            sharedState.forkConfig = { finalityProofs: { activationHeight: 4201 } }
            getTransactionStatus.mockResolvedValue({ state: "included", blockNumber: 4199 })
            expect((await getTransactionStatusCall({ hash: HASH })).response).not.toHaveProperty("resultCommittedInBlock")
            getTransactionStatus.mockResolvedValue({ state: "included", blockNumber: 4200 })
            expect((await getTransactionStatusCall({ hash: HASH })).response.resultCommittedInBlock).toBe(4201)
        })
    })
})

describe("getBlockByNumber", () => {
    it("serves block 0 for a numeric or text 0", async () => {
        for (const blockNumber of [0, "0"]) {
            const reply = await getBlockByNumberCall({ blockNumber })
            expect(reply.result).toBe(200)
            expect(reply.response).toEqual({ number: 0, hash: "83082fbb" })
        }
    })

    it("serves other heights from the chain", async () => {
        getBlockByNumber.mockResolvedValue({ number: 5, hash: "aa" })
        const reply = await getBlockByNumberCall({ blockNumber: "5" })
        expect(reply.result).toBe(200)
        expect(getBlockByNumber).toHaveBeenCalledWith(5)
    })

    it("refuses a missing, negative, fractional or partly numeric height", async () => {
        for (const blockNumber of [undefined, null, -1, 1.5, "12abc", "", "-3"]) {
            expect((await getBlockByNumberCall({ blockNumber })).result).toBe(400)
        }
        expect(getBlockByNumber).not.toHaveBeenCalled()
    })
})

describe("getTransactions", () => {
    it("returns amount and fee columns as decimal strings, so the page serialises", async () => {
        getTransactions.mockResolvedValue([
            { id: 9, hash: "aa", amount: 12345678901234567890n, networkFee: 1n, rpcFee: 0n, additionalFee: null, nonce: "3" },
        ])
        const reply = await getTransactionsCall({ start: "latest", limit: 10 })
        expect(reply.result).toBe(200)
        expect(reply.response).toEqual([
            { id: 9, hash: "aa", amount: "12345678901234567890", networkFee: "1", rpcFee: "0", additionalFee: null, nonce: "3" },
        ])
        expect(() => JSON.stringify(reply)).not.toThrow()
    })

    it("defaults to the latest 100 when the SDK leaves both out", async () => {
        await getTransactionsCall({} as any)
        expect(getTransactions).toHaveBeenCalledWith("latest", 100)
    })

    it("caps the page at 100, like the history call", async () => {
        await getTransactionsCall({ start: "latest", limit: 1_000_000 })
        await getTransactionsCall({ start: 50, limit: 101 })
        await getTransactionsCall({ start: 50, limit: 7 })
        expect(getTransactions.mock.calls).toEqual([
            ["latest", 100],
            [50, 100],
            [50, 7],
        ])
    })

    it("refuses a limit below 1 or a negative or fractional start", async () => {
        for (const data of [{ start: "latest", limit: 0 }, { start: "latest", limit: -5 }, { start: -1, limit: 5 }, { start: 1.5, limit: 5 }, { start: "latest", limit: 2.5 }, { start: "latest", limit: "10" }, { start: "latest", limit: Number.POSITIVE_INFINITY }]) {
            expect((await getTransactionsCall(data as any)).result).toBe(400)
        }
        expect(getTransactions).not.toHaveBeenCalled()
    })
})
