/**
 * Blocks keep transactions that did not execute (a low nonce, an expired
 * reference block, a failed state change). The status a client polls must
 * say so: one that waits for "included" would otherwise count a payment
 * that never moved money as paid.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"

import { mockTransactionStore } from "./transactionStoreMocks"

const { findOneBy, findByHash } = mockTransactionStore()

const { getTransactionStatus } = await import("./chainTransactions")
const { __clearDroppedTxs: clearDroppedTxs, recordDropped } = await import("./droppedTransactions")

function storedRow(status: string, attrs: Record<string, unknown> | null = null) {
    return {
        blockNumber: 480877,
        signature: JSON.stringify({ type: "ed25519", data: "00" }),
        status,
        hash: "85b8fcdc",
        content: JSON.stringify({ type: "native", from: "0xa", to: "0xb", amount: 9 }),
        type: "native",
        from: "0xa",
        to: "0xb",
        from_ed25519_address: null,
        amount: 9n,
        nonce: "3",
        timestamp: "1760000000000",
        networkFee: 0n,
        rpcFee: 0n,
        additionalFee: 0n,
        ed25519_signature: null,
        attrs,
    }
}

beforeEach(() => {
    findOneBy.mockReset()
    findOneBy.mockResolvedValue(null)
    findByHash.mockReset()
    findByHash.mockResolvedValue(null)
    clearDroppedTxs()
})

describe("Chain.getTransactionStatus", () => {
    it("reports a transaction in a block that executed as included", async () => {
        findOneBy.mockResolvedValue(storedRow("confirmed"))
        expect(await getTransactionStatus("85b8fcdc")).toEqual({ state: "included", blockNumber: 480877 })
    })

    it("reports one in a block that did not execute as failed, with the stored code and message", async () => {
        findOneBy.mockResolvedValue(
            storedRow("failed", { code: "TX_NONCE_INVALID_LOW", message: "Nonce too low", reference_block: 480870 }),
        )
        expect(await getTransactionStatus("85b8fcdc")).toEqual({
            state: "failed",
            blockNumber: 480877,
            code: "TX_NONCE_INVALID_LOW",
            message: "Nonce too low",
        })
    })

    it("reads attrs stored as text", async () => {
        findOneBy.mockResolvedValue(storedRow("failed", JSON.stringify({ code: "TX_EXPIRED" }) as any))
        expect(await getTransactionStatus("85b8fcdc")).toEqual({ state: "failed", blockNumber: 480877, code: "TX_EXPIRED" })
    })

    it("still reports failed when no reason was recorded", async () => {
        findOneBy.mockResolvedValue(storedRow("failed"))
        expect(await getTransactionStatus("85b8fcdc")).toEqual({ state: "failed", blockNumber: 480877 })
    })

    it("reports a mempool transaction as pending, and checks the chain first", async () => {
        const order: string[] = []
        findOneBy.mockImplementation(async () => {
            order.push("chain")
            return null
        })
        findByHash.mockImplementation(async () => {
            order.push("mempool")
            return { hash: "85b8fcdc" }
        })
        expect(await getTransactionStatus("85b8fcdc")).toEqual({ state: "pending" })
        expect(order).toEqual(["chain", "mempool"])
    })

    it("reports a hash it holds nowhere as unknown", async () => {
        expect(await getTransactionStatus("85b8fcdc")).toEqual({ state: "unknown" })
    })
})

// #973: a tx that left the mempool without a block taking it is told apart
// from a hash the node never saw.
describe("Chain.getTransactionStatus after a drop from the mempool", () => {
    it("reports it dropped, with the reason and when", async () => {
        recordDropped(["85b8fcdc"], "evicted_fee", 480900)
        expect(await getTransactionStatus("85b8fcdc")).toEqual({
            state: "dropped",
            reason: "evicted_fee",
            droppedAtBlock: 480900,
            droppedAt: expect.any(Number),
        })
    })

    it("reports it included when a block carries it after all", async () => {
        recordDropped(["85b8fcdc"], "expired", 480870)
        findOneBy.mockResolvedValue(storedRow("confirmed"))
        expect(await getTransactionStatus("85b8fcdc")).toEqual({ state: "included", blockNumber: 480877 })
    })

    it("reports it failed when a block kept it without executing it", async () => {
        recordDropped(["85b8fcdc"], "expired", 480870)
        findOneBy.mockResolvedValue(storedRow("failed", { code: "TX_NONCE_INVALID_LOW" }))
        expect(await getTransactionStatus("85b8fcdc")).toMatchObject({ state: "failed", code: "TX_NONCE_INVALID_LOW" })
    })

    it("reports it pending once it is back in the mempool", async () => {
        recordDropped(["85b8fcdc"], "evicted_sender_cap", 480870)
        findByHash.mockResolvedValue({ hash: "85b8fcdc" })
        expect(await getTransactionStatus("85b8fcdc")).toEqual({ state: "pending" })
    })

    it("still reports a hash it never held unknown", async () => {
        recordDropped(["85b8fcdc"], "evicted_fee", 480900)
        expect(await getTransactionStatus("0badc0de")).toEqual({ state: "unknown" })
    })
})
