/**
 * Forging leaves settlement batches past the per-block cap in the pool, the
 * same ones (in canonical order) block apply would fail, so a forged block
 * never carries a batch every validator is bound to fail.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"

mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug() {}, info() {}, warning() {}, warn() {}, error() {}, only() {}, custom() {} },
}))
mock.module("src/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: { getAccountNonces: async () => ({}) },
}))

import { cloneDefaultForkConfig } from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"
import { MAX_SETTLEMENT_BATCHES_PER_BLOCK } from "@/libs/l2ps/settlement/validation"
import { judgeBlockTransactions } from "./blockTransactions"
import { orderDeterministically } from "./deterministicOrder"

const NODE = "0x" + "ab".repeat(32)
const saved = {
    forkConfig: getSharedState.forkConfig,
    lastBlockNumber: getSharedState.lastBlockNumber,
    referenceBlockRoom: getSharedState.referenceBlockRoom,
}

function batch(i: number) {
    return {
        hash: i.toString(16).padStart(64, "0"),
        status: "pending",
        reference_block: 100,
        content: {
            type: "l2psBatch",
            from: NODE,
            from_ed25519_address: NODE,
            // Reverse nonce order, so the canonical order differs from the input order.
            nonce: 1_000 - i,
            gcr_edits: [],
            data: ["l2psBatch", {}],
        },
    } as any
}

const CAPS = { caps: { maxTxs: 1_000, maxContentBytes: 16 * 1024 * 1024 }, osDenominationActive: true }

function forks(settlement: number | null) {
    getSharedState.forkConfig = cloneDefaultForkConfig()
    getSharedState.forkConfig.l2psSettlement.activationHeight = settlement
}

beforeEach(() => {
    getSharedState.lastBlockNumber = 100
    getSharedState.referenceBlockRoom = 1
})

afterEach(() => {
    Object.assign(getSharedState, saved)
})

describe("judgeBlockTransactions and the settlement batch cap", () => {
    const pool = Array.from({ length: MAX_SETTLEMENT_BATCHES_PER_BLOCK + 3 }, (_, i) => batch(i))

    it("keeps the first 20 batches in canonical order under the fork", async () => {
        forks(0)
        const judged = await judgeBlockTransactions(pool, 101, CAPS as any)
        const expected = orderDeterministically(pool).slice(0, MAX_SETTLEMENT_BATCHES_PER_BLOCK)
        expect(judged.txs.map(t => t.hash).sort()).toEqual(expected.map(t => t.hash).sort())
    })

    it("leaves the pool uncapped before the fork", async () => {
        forks(null)
        const judged = await judgeBlockTransactions(pool, 101, CAPS as any)
        expect(judged.txs).toHaveLength(pool.length)
    })
})
