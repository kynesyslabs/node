/**
 * The mempool insert holds a transaction to the limits of the `transactions`
 * row the block insert writes for it, as the consensus merge and the block
 * re-check do. The node builds some transactions itself (instant messages,
 * L2PS batches) and adds them here without passing admission, so this is
 * where their row is judged before they reach the pool.
 *
 * Only the database is replaced; the insert's own checks run as written,
 * except the pool caps, which mempool.caps.test.ts covers.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { installPoolStorageMocks } from "./mempool.fixtures"
import { mockLogger } from "./testSupport/mockMempoolDeps"
import { INDEX_KEY_MAX_BYTES, transactionRowRefusal } from "./validation/postgresStorable"
import { getSharedState } from "@/utilities/sharedState"
import Mempool from "./mempool"

installPoolStorageMocks()
mockLogger("src/utilities/logger")

const NODE = "0x" + "ab".repeat(32)
const ACCOUNT = "0x" + "cd".repeat(32)

/** An instant message as the signalling server builds it, addressed to `to`. */
function message(to: string) {
    const timestamp = Date.now()
    return {
        hash: "0x" + "ef".repeat(32),
        content: {
            type: "instantMessaging",
            from: NODE,
            to,
            from_ed25519_address: NODE,
            amount: 0,
            data: ["instantMessaging", { senderId: "a", targetId: to, message: "m", timestamp }],
            gcr_edits: [],
            nonce: 1,
            timestamp,
            reference_block: 100,
            transaction_fee: { network_fee: 0, rpc_fee: 0, additional_fee: 0, rpc_address: null },
        },
        signature: { type: "ed25519", data: "00" },
        status: "",
        reference_block: 100,
    } as never
}

const pool = Mempool as any
const original = {
    repo: pool.repo,
    checkAdmission: pool.checkAdmission,
    checkTransactionByHash: pool.checkTransactionByHash,
}
const saved: Array<Record<string, unknown>> = []

beforeEach(() => {
    saved.length = 0
    // Every fork dormant: the insert takes the plain path, without the
    // nonce re-check's database transaction.
    getSharedState.forkConfig = {} as never
    getSharedState.lastBlockNumber = 100
    pool.checkAdmission = async () => ({ evict: [] })
    pool.checkTransactionByHash = async () => false
    pool.repo = {
        save: async (row: Record<string, unknown>) => {
            saved.push(row)
            return row
        },
    }
})

afterEach(() => {
    Object.assign(pool, original)
})

describe("Mempool.addTransaction", () => {
    it("refuses a `to` longer than its index holds, as the merge does", async () => {
        const tx = message("x".repeat(1100))
        const refusal = transactionRowRefusal(tx)
        expect(refusal).toContain("Transaction to is longer than")

        const out = await Mempool.addTransaction(tx)
        expect(out).toEqual({ confirmationBlock: null, error: refusal })
        expect(saved).toEqual([])
    })

    it("measures the `to` in UTF-8 bytes", async () => {
        const out = await Mempool.addTransaction(message("é".repeat(INDEX_KEY_MAX_BYTES / 2 + 1)))
        expect(out.error).toContain("Transaction to is longer than")
        expect(saved).toEqual([])
    })

    it("admits a `to` of exactly the bytes its index holds", async () => {
        const tx = message("x".repeat(INDEX_KEY_MAX_BYTES))
        expect(transactionRowRefusal(tx)).toBeNull()

        const out = await Mempool.addTransaction(tx)
        expect(out).toEqual({ confirmationBlock: 101, error: "" })
        expect(saved).toHaveLength(1)
    })

    it("admits an instant message to an account address", async () => {
        const out = await Mempool.addTransaction(message(ACCOUNT))
        expect(out).toEqual({ confirmationBlock: 101, error: "" })
        expect(saved.map(row => (row.content as { to: string }).to)).toEqual([ACCOUNT])
    })
})
