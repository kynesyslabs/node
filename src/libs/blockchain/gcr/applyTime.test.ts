/**
 * What block apply stamps into state must be the same bytes on every node,
 * and on every node that syncs the block later: the block's timestamp, not
 * the clock of whoever applies it.
 */

import { describe, expect, it, mock } from "bun:test"
import { mockDatasource, mockLogger, mockXmLocalSdk } from "@/utilities/testSupport/coreMocks"

mockDatasource({ findOne: async () => null })
mockLogger()

const { applyTime, bindApplyTime, withBlockTime } = await import("./applyTime")
const { default: HandleGCR } = await import("./handleGCR")
const { applyAwardPoints } = await import("./gcr_routines/routines/rewardsRoutines")
const { ProofVerifier } = await import("@/features/zk/proof/ProofVerifier")
const { ATTESTATION_CONTEXT_SIGNAL } = await import("@/features/zk/proof/publicSignals")
const { applyZkAttestationAdd } = await import("./gcr_routines/routines/zkRoutines")

const BLOCK_SEC = 1_794_700_800
const BLOCK_TIME = new Date(BLOCK_SEC * 1000)
const ACCOUNT = "0x" + "6c".repeat(32)
const clock = { height: 12, timestampSec: BLOCK_SEC }

describe("apply time", () => {
    it("is the block's timestamp for everything a block apply runs", async () => {
        const original = (HandleGCR as any).applyTransactionsAt
        let seen: Date | null = null
        ;(HandleGCR as any).applyTransactionsAt = async () => {
            await Promise.resolve()
            seen = applyTime()
            return { successfulTxs: [], failedTxs: [], skippedTxs: [] }
        }
        try {
            await HandleGCR.applyTransactions([], false, clock)
        } finally {
            ;(HandleGCR as any).applyTransactionsAt = original
        }
        expect(seen).toEqual(BLOCK_TIME)
    })

    it("stays the block's for work that runs after apply returns", async () => {
        const later = withBlockTime(BLOCK_SEC, () => bindApplyTime(async () => applyTime()))
        expect(await later()).toEqual(BLOCK_TIME)
    })

    it("stamps a new account with the block's time", async () => {
        const account = await withBlockTime(BLOCK_SEC, () => HandleGCR.createAccount(ACCOUNT, {}, true))
        expect(account.createdAt).toEqual(BLOCK_TIME)
        expect(account.points.lastUpdated).toEqual(BLOCK_TIME)
    })

    it("stamps a sudo points award with the block's time", async () => {
        const account = await HandleGCR.createAccount(ACCOUNT, {}, true)
        await withBlockTime(BLOCK_SEC, () =>
            applyAwardPoints({ account: ACCOUNT, amount: 5, date: "2026-11-15T00:00:00.000Z" }, account),
        )
        expect(account.points.lastUpdated).toEqual(BLOCK_TIME)
    })

    it("stamps a ZK attestation's points entry with the block's time, in the block's write", async () => {
        ProofVerifier.prototype.checkIdentityAttestation = async (a: any) =>
            ({ valid: true, nullifier: a.publicSignals[0], context: a.publicSignals[1], merkleRoot: a.publicSignals[2] }) as any
        ProofVerifier.prototype.verifyIdentityAttestation = async () => ({ valid: true }) as any
        const edit = {
            type: "identity",
            operation: "zk_attestationadd",
            account: ACCOUNT,
            txhash: "cc".repeat(32),
            data: {
                nullifier_hash: "1" + "d".repeat(63),
                merkle_root: "2" + "e".repeat(63),
                proof: { pi_a: [], pi_b: [], pi_c: [], protocol: "groth16" },
                public_signals: ["123", ATTESTATION_CONTEXT_SIGNAL, "456"],
            },
        }
        const result = await withBlockTime(BLOCK_SEC, async () => {
            const r = await applyZkAttestationAdd(edit, false, { zkNullifiers: new Map() } as any)
            return { ...r, deferredWrite: r.deferredWrite && bindApplyTime(r.deferredWrite) }
        })
        expect(result.success).toBe(true)

        const account = await HandleGCR.createAccount(ACCOUNT, {}, true)
        let saved: any = null
        const em: any = {
            getRepository: () => ({ findOne: async () => account, save: async (row: any) => (saved = row) }),
            save: async (row: any) => (saved = row),
        }
        await result.deferredWrite!(em)

        expect(saved.points.breakdown.zkAttestation.at(-1).date).toBe(BLOCK_TIME.toISOString())
        expect(saved.points.lastUpdated).toEqual(BLOCK_TIME)
    })
})
