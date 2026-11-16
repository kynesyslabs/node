/**
 * A worker chunk that fails or times out says nothing about its
 * transactions. Reported as invalid, it made a forger fail valid PQC
 * transactions out of a block; the chunk is judged again on the main thread,
 * and only a transaction that cannot be judged at all is left undecided.
 */

import { describe, expect, it, mock } from "bun:test"
import { mockLogger } from "@/utilities/testSupport/coreMocks"

mockLogger()
mock.module("./prefetchIdentities", () => ({ __esModule: true, default: async () => ({}) }))

const { default: TxValidatorPool } = await import("./txValidatorPool")
const { IdentityPrefetchError } = await import("./identityPrefetchError")

const txs = [{ hash: "a" }, { hash: "b" }, { hash: "c" }] as any[]
const domain = { active: false, chainId: 0 }

function poolWithFailingChunks(inline: (txs: any[]) => Promise<any[]>) {
    const pool = new (TxValidatorPool as any)()
    pool.started = true
    pool.workers = [{}, {}]
    pool.dispatchChunk = async () => {
        throw new Error("worker timed out")
    }
    pool.validateInline = inline
    return pool
}

describe("TxValidatorPool when a worker chunk fails", () => {
    it("judges the chunk's transactions inline instead of calling them invalid", async () => {
        const pool = poolWithFailingChunks(async batch => batch.map(tx => ({ hash: tx.hash, valid: true })))
        const results = await pool.validate(txs, true, domain)
        expect(results).toEqual(txs.map(tx => ({ hash: tx.hash, valid: true })))
    })

    it("marks them undecided, not invalid, when the inline judgement fails too", async () => {
        const pool = poolWithFailingChunks(async () => {
            throw new Error("database down")
        })
        const results = await pool.validate(txs, true, domain)
        expect(results.map((r: any) => [r.hash, r.valid, r.undecided])).toEqual(
            txs.map(tx => [tx.hash, false, true]),
        )
    })

    it("passes unreadable identity records on to the caller instead of calling them undecided", async () => {
        const pool = poolWithFailingChunks(async () => {
            throw new IdentityPrefetchError(new Error("database down"))
        })
        await expect(pool.validate(txs, true, domain)).rejects.toBeInstanceOf(IdentityPrefetchError)
    })
})
