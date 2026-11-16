/**
 * Mainnet launches with L2PS off. Under `l2psGate` the four L2PS transaction
 * types are refused at RPC intake, pool admission and apply, a transaction
 * applied on its own (the simulation, an L2PS proof) is refused before its
 * edits, and consensus applies no pending L2PS proof: a proof debits the L2
 * fee from the sender with no credit, so applying one would break supply
 * conservation.
 *
 * The transactions come from the real SDK signer.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { mockEntityDatasource } from "@/utilities/testSupport/coreMocks"

mockEntityDatasource()

const {
    SENDER_BALANCE,
    describeForkConfig,
    describeTxGate,
    mainnetForks,
    mockChainAndLogger,
    restoreForkConfigAfterEach,
    stubBlockApply,
} = await import("@/libs/blockchain/testSupport/forkGates")
mockChainAndLogger()

const handleGCR = (await import("@/libs/blockchain/gcr/handleGCR")).default
const { SENDER } = await import("@/libs/blockchain/validation/editBinding.fixtures")
const { l2psTxs, pay } = await import("@/libs/blockchain/testSupport/featureGateTxs")
const { L2PS_GATE_REFUSAL, L2PS_TX_TYPES, isL2psTx, l2psGateRefusal, l2psOffAt } = await import("./l2psGate")
const { default: L2PSProofManager } = await import("@/libs/l2ps/L2PSProofManager")
const { default: L2PSConsensus } = await import("@/libs/l2ps/L2PSConsensus")

restoreForkConfigAfterEach()

/** The mainnet forks, with l2psGate at `height`. */
const gate = (height: number | null) => mainnetForks({ l2psGate: height })

describeForkConfig("l2psGate")

describe("l2psGate types", () => {
    it("covers the four L2PS transaction types and nothing else", () => {
        expect([...L2PS_TX_TYPES].sort()).toEqual(["l2psBatch", "l2psEncryptedTx", "l2ps_hash_update", "subnet"])
        for (const type of ["native", "identity", "instantMessaging", {}, 1, null]) {
            expect(isL2psTx({ content: { type } })).toBe(false)
        }
        expect(isL2psTx({})).toBe(false)
    })

    it("refuses only while the gate is active, from the tip it is pinned at", () => {
        gate(50)
        expect(l2psOffAt(49)).toBe(false)
        expect(l2psOffAt(50)).toBe(true)
        const tx = { content: { type: "l2psEncryptedTx" } }
        expect(l2psGateRefusal(tx, false)).toBeNull()
        expect(l2psGateRefusal(tx, true)).toBe(L2PS_GATE_REFUSAL)
    })
})

describeTxGate({
    fork: "l2psGate",
    gated: "every L2PS type",
    refusal: L2PS_GATE_REFUSAL,
    txs: l2psTxs,
    other: pay,
    handleGCR,
})

describe("pending L2PS proofs at consensus", () => {
    const spies: { mockRestore(): void }[] = []
    afterEach(() => spies.splice(0).forEach(s => s.mockRestore()))

    /** A pending proof that debits the L2 fee from SENDER, and spies on everything that would apply it. */
    const stubProofs = () => {
        const getProofs = spyOn(L2PSProofManager, "getProofsForBlock").mockResolvedValue([
            {
                id: 1,
                l2ps_uid: "net",
                transactions_hash: "ab".repeat(32),
                affected_accounts_count: 1,
                gcr_edits: [{ type: "balance", account: SENDER, operation: "remove", amount: "1000" }],
            } as any,
        ])
        const verify = spyOn(L2PSProofManager, "verifyProof").mockResolvedValue(true)
        const prepare = spyOn(handleGCR, "prepareEntities").mockResolvedValue({} as any)
        const applyTx = spyOn(handleGCR, "applyTransaction").mockResolvedValue({ success: false, message: "stop" } as any)
        const applyEdit = spyOn(handleGCR, "applyGCREdit")
        spies.push(getProofs, verify, prepare, applyTx, applyEdit)
        return { getProofs, applyTx, applyEdit }
    }

    it("applies no proof and no edit while the gate is active", async () => {
        gate(0)
        const s = stubProofs()

        const result = await L2PSConsensus.applyPendingProofs(101, false, undefined, 1)

        expect(result).toMatchObject({ success: true, proofsApplied: 0, proofsFailed: 0, totalEditsApplied: 0 })
        expect(result.message).toBe(L2PS_GATE_REFUSAL)
        expect(s.getProofs).not.toHaveBeenCalled()
        expect(s.applyTx).not.toHaveBeenCalled()
        expect(s.applyEdit).not.toHaveBeenCalled()
    })

    it("judges block N on tip N - 1, the height every gate reads", async () => {
        gate(101)
        const s = stubProofs()
        await L2PSConsensus.applyPendingProofs(101, true, undefined, 1)
        expect(s.getProofs).toHaveBeenCalledTimes(1)
        await L2PSConsensus.applyPendingProofs(102, true, undefined, 1)
        expect(s.getProofs).toHaveBeenCalledTimes(1)
    })

    it("still reaches the proofs while the gate is dormant", async () => {
        gate(null)
        const s = stubProofs()
        await L2PSConsensus.applyPendingProofs(101, true, undefined, 1)
        expect(s.getProofs).toHaveBeenCalledWith(101)
        expect(s.applyTx).toHaveBeenCalled()
    })
})

describe("the proof apply mock transaction", () => {
    const block = stubBlockApply(handleGCR)

    it("is refused by apply under the gate, so a proof edit cannot land even if consensus called it", async () => {
        gate(0)
        // What L2PSConsensus.createMockTx builds for a proof edit.
        const mockTx = {
            hash: "ab".repeat(32),
            content: {
                type: "l2psEncryptedTx",
                from: SENDER,
                to: SENDER,
                from_ed25519_address: SENDER,
                timestamp: 1,
                gcr_edits: [{ type: "balance", account: SENDER, operation: "remove", amount: "1000", isRollback: false, txhash: "" }],
            },
        } as any
        const out = await handleGCR.applyTransaction(block.caches, mockTx, false, false)
        expect(out).toMatchObject({ success: false, message: L2PS_GATE_REFUSAL })
        expect((block.caches.accounts.get(SENDER) as any).balance).toBe(SENDER_BALANCE)
    })
})
