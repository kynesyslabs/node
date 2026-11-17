/**
 * Apply only fails a settlement batch it refuses, so before this check any
 * key could sign a batch that every member merged and every block carried for
 * free, ahead of real ones in the per-block cap. Under `l2psSettlement` a
 * batch enters the pool, on the producer and in the merge alike, only from a
 * validator staked at the tip, ordered under its own key, and with the checks
 * apply makes before it reads state: record shape, fee, fee credits and every
 * transfer's signature.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import {
    mainnetForks,
    mockChainAndLogger,
    restoreForkConfigAfterEach,
    stubValidatorSet,
} from "@/libs/blockchain/testSupport/forkGates"

mockChainAndLogger()

const { admissionReads, loadAdmissionReads, verifyAdmissionEdits } = await import(
    "@/libs/blockchain/validation/editBinding"
)
const { default: GCR } = await import("@/libs/blockchain/gcr/gcr")
const { default: Mempool } = await import("@/libs/blockchain/mempool")
const { default: Chain } = (await import("src/libs/blockchain/chain")) as { default: Record<string, unknown> }
const { getSharedState } = await import("@/utilities/sharedState")
const { CHAIN_ID, batchTx, key, recordOf, signedTransfer } = await import(
    "@/libs/l2ps/settlement/__fixtures__/settlementKit"
)

const validators = stubValidatorSet(GCR)
restoreForkConfigAfterEach()

const OS = 1_000_000_000n
const FEE = 3n * OS
const ALICE = key(1)
const BOB = key(2)
const NODE = key(200)
const LOW = "0x" + "00".repeat(31) + "01"

const saved = {
    chainId: getSharedState.chainId,
    networkFee: getSharedState.networkFee,
    rpcFee: getSharedState.rpcFee,
    additionalFee: getSharedState.additionalFee,
    feeDistribution: (getSharedState as any).feeDistribution,
}

beforeEach(() => {
    getSharedState.chainId = CHAIN_ID
    getSharedState.networkFee = 1
    getSharedState.rpcFee = 1
    getSharedState.additionalFee = 1
    ;(getSharedState as any).feeDistribution = {
        burnAddress: "0x" + "00".repeat(32),
        treasuryAddress: "0x" + "f7".repeat(32),
        networkFee: { burnPct: 50, treasuryPct: 50 },
        additionalFee: { burnPct: 50, treasuryPct: 50 },
        specialOps: { burnPct: 50, rpcPct: 25, treasuryPct: 25 },
    }
    validators.keys = [NODE.account]
})

afterEach(() => {
    Object.assign(getSharedState, {
        chainId: saved.chainId,
        networkFee: saved.networkFee,
        rpcFee: saved.rpcFee,
        additionalFee: saved.additionalFee,
    })
    ;(getSharedState as any).feeDistribution = saved.feeDistribution
    delete Chain.checkTxExists
})

const forks = (settlement: number | null) => mainnetForks({ l2psSettlement: settlement })

const transfer = (opts: { fee?: bigint; chainId?: number } = {}) =>
    signedTransfer({ from: ALICE, to: BOB.account, amount: 5n * OS, fee: opts.fee ?? FEE, nonce: 1n, chainId: opts.chainId })

/** A batch as the aggregator of `from` builds it. */
const batch = (opts: { from?: string; fee?: bigint; chainId?: number } = {}) =>
    batchTx(recordOf([transfer(opts)]), { from: opts.from ?? NODE.account })

describe("a peer's settlement batch in the merge", () => {
    it("is admitted from a validator staked at the tip", async () => {
        forks(0)
        expect(await verifyAdmissionEdits(batch())).toEqual({ ok: true })
        expect(validators.reads).toEqual([100])
    })

    it("is refused when a key outside the validator set signed it", async () => {
        forks(0)
        const verdict = await verifyAdmissionEdits(batch({ from: key(9).account }))
        expect(verdict).toEqual({
            ok: false,
            reason: "settlement batch is not signed by a validator staked at the tip",
        })
    })

    it("is refused when ordered under a key other than its signer's", async () => {
        forks(0)
        const tx = batch()
        tx.content.from_ed25519_address = LOW
        const verdict = await verifyAdmissionEdits(tx)
        expect(verdict).toEqual({
            ok: false,
            reason: "settlement batch is ordered under a key other than its signer's",
        })
    })

    it("is refused, not thrown on, when it has no address to order it by", async () => {
        forks(0)
        const tx = batch()
        delete tx.content.from_ed25519_address
        const verdict = await verifyAdmissionEdits(tx)
        expect(verdict).toEqual({
            ok: false,
            reason: "settlement batch has no sender address to order it by",
        })
    })

    it("is refused when a transfer's signature is bound to another chain", async () => {
        forks(0)
        const verdict = await verifyAdmissionEdits(batch({ chainId: CHAIN_ID + 1 }))
        expect(verdict.ok).toBe(false)
        expect(verdict.reason).toContain("signature does not verify")
    })

    it("is refused when a transfer pays less than the native transfer fee", async () => {
        forks(0)
        const verdict = await verifyAdmissionEdits(batch({ fee: FEE - 1n }))
        expect(verdict.ok).toBe(false)
        expect(verdict.reason).toContain("fee")
    })

    it("is refused when it carries no settlement record", async () => {
        forks(0)
        const verdict = await verifyAdmissionEdits(batchTx(undefined, { from: NODE.account }))
        expect(verdict).toEqual({ ok: false, reason: "l2psBatch carries no settlement record (old format)" })
    })

    it("refuses, rather than admits, when the validator set cannot be read", async () => {
        forks(0)
        validators.fails = true
        const verdict = await verifyAdmissionEdits(batch())
        expect(verdict.ok).toBe(false)
        expect(verdict.reason).toContain("validator set")
    })

    it("has the validator set read once for the whole merge", async () => {
        forks(0)
        const reads = admissionReads()
        const txs = [batch(), batch(), batch()]
        await loadAdmissionReads(txs, reads)
        for (const tx of txs) expect(await verifyAdmissionEdits(tx, reads)).toEqual({ ok: true })
        expect(validators.reads).toEqual([100])
    })

    it("is admitted from any key, without a validator read, while the fork is dormant", async () => {
        forks(null)
        expect(await verifyAdmissionEdits(batch({ from: key(9).account }))).toEqual({ ok: true })
        expect(validators.reads).toEqual([])
    })
})

describe("the producer's own settlement batch", () => {
    const pooled = "the batch reached the duplicate lookup"

    beforeEach(() => {
        Chain.checkTxExists = async () => {
            throw new Error(pooled)
        }
    })

    it("is refused by the verdict a peer's merge would give it", async () => {
        forks(0)
        const out = await Mempool.addTransaction({ ...batch({ from: key(9).account }), reference_block: 100 })
        expect(out).toEqual({
            confirmationBlock: null,
            error: "settlement batch is not signed by a validator staked at the tip",
        })
    })

    it("is refused when the validator set cannot be read", async () => {
        forks(0)
        validators.fails = true
        const out = await Mempool.addTransaction({ ...batch(), reference_block: 100 })
        expect(out.confirmationBlock).toBeNull()
        expect(out.error).toContain("settlement batch could not be checked")
    })

    it("goes on to the pool when a peer's merge would admit it", async () => {
        forks(0)
        await expect(Mempool.addTransaction({ ...batch(), reference_block: 100 })).rejects.toThrow(pooled)
    })

    it("goes on to the pool from any key while the fork is dormant", async () => {
        forks(null)
        await expect(
            Mempool.addTransaction({ ...batch({ from: key(9).account }), reference_block: 100 }),
        ).rejects.toThrow(pooled)
        expect(validators.reads).toEqual([])
    })
})
