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

import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { DemosTransactions } from "@kynesyslabs/demosdk/websdk"

const repoFor = (name: string) => ({
    target: { name },
    create: (row: unknown) => ({ ...(row as object) }),
    findOneBy: async () => null,
    findOne: async () => null,
    find: async () => [],
    save: async (row: unknown) => row,
})
const fakeDataSource = {
    getRepository: (entity: any) => repoFor(entity?.name ?? String(entity)),
}
const datasourceModule = () => ({
    __esModule: true,
    dataSource: fakeDataSource,
    default: { getInstance: async () => ({ getDataSource: () => fakeDataSource }) },
})
mock.module("src/model/datasource", datasourceModule)
mock.module("@/model/datasource", datasourceModule)

const {
    SENDER_BALANCE,
    chainTip,
    describeForkConfig,
    mainnetForks,
    mockChainAndLogger,
    restoreForkConfigAfterEach,
    stubBlockApply,
} = await import("@/libs/blockchain/testSupport/forkGates")
mockChainAndLogger()

const handleGCR = (await import("@/libs/blockchain/gcr/handleGCR")).default
const { verifyAdmissionEdits, verifyRpcEdits } = await import("@/libs/blockchain/validation/editBinding")
const { PEER, SENDER, demos, handMade, onTheWire } = await import("@/libs/blockchain/validation/editBinding.fixtures")
const { L2PS_GATE_REFUSAL, L2PS_TX_TYPES, isL2psTx, l2psGateRefusal, l2psOffAt } = await import("./l2psGate")
const { default: L2PSProofManager } = await import("@/libs/l2ps/L2PSProofManager")
const { default: L2PSConsensus } = await import("@/libs/l2ps/L2PSConsensus")

restoreForkConfigAfterEach()

/** One signed transaction of each L2PS type, with the universal edits the SDK gives every type. */
const l2psTxs = async () => [
    onTheWire(await handMade("l2psEncryptedTx", { l2ps_uid: "net", encrypted_data: "x", tag: "t", original_hash: "ab".repeat(32) })),
    onTheWire(await handMade("subnet", { l2ps_uid: "net", encrypted_data: "x" })),
    onTheWire(await handMade("l2ps_hash_update", { l2ps_uid: "net", consolidated_hash: "cd".repeat(32), transaction_count: 1 })),
    onTheWire(await handMade("l2psBatch", { l2ps_uid: "net", batch_hash: "ef".repeat(32) })),
]
const pay = async () => onTheWire(await DemosTransactions.pay(PEER, 3n, demos))

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

describe("intake", () => {
    it("pool admission refuses every L2PS type while the gate is active", async () => {
        gate(0)
        for (const tx of await l2psTxs()) {
            expect(await verifyAdmissionEdits(tx)).toEqual({ ok: false, reason: L2PS_GATE_REFUSAL })
        }
    })

    it("RPC submission refuses them too", async () => {
        gate(0)
        for (const tx of await l2psTxs()) {
            expect(await verifyRpcEdits(tx)).toEqual({ ok: false, reason: L2PS_GATE_REFUSAL })
        }
    })

    it("admits other transactions while the gate is active", async () => {
        gate(0)
        expect(await verifyAdmissionEdits(await pay())).toEqual({ ok: true })
        expect(await verifyRpcEdits(await pay())).toEqual({ ok: true })
    })

    it("does not refuse them for L2PS while the gate is dormant", async () => {
        gate(null)
        for (const tx of await l2psTxs()) {
            expect((await verifyRpcEdits(tx)).reason).not.toBe(L2PS_GATE_REFUSAL)
        }
    })
})

describe("block apply", () => {
    const block = stubBlockApply(handleGCR)
    const sender = () => block.caches.accounts.get(SENDER) as any

    it("refuses every L2PS type in the pre-pass, next to a transaction the block applies", async () => {
        gate(0)
        const txs = await l2psTxs()
        const good = await pay()
        expect(await block.refused([...txs, good])).toEqual(txs.map(tx => tx.hash))
    })

    it("fails them with no balance or nonce change", async () => {
        gate(0)
        const txs = await l2psTxs()
        const out = await block.apply(txs)
        expect(out.failedTxs.sort()).toEqual(txs.map(tx => tx.hash).sort())
        expect(out.successfulTxs).toEqual([])
        expect(sender().balance).toBe(SENDER_BALANCE)
        expect(sender().nonce).toBe(7)
    })

    it("judges the gate from the tip, like the other apply gates", async () => {
        gate(101)
        const [tx] = await l2psTxs()
        expect(await block.refused([tx])).toEqual([])
        chainTip.height = 101
        expect(await block.refused([tx])).toEqual([tx.hash])
    })

    it("refuses one applied on its own before any edit, and charges nothing", async () => {
        gate(0)
        for (const tx of await l2psTxs()) {
            for (const simulate of [true, false]) {
                const out = await handleGCR.applyTransaction(block.caches, tx, false, simulate)
                expect(out).toMatchObject({ success: false, message: L2PS_GATE_REFUSAL, appliedEditsCount: 0, unproven: true })
            }
        }
        expect(sender().balance).toBe(SENDER_BALANCE)
        expect(sender().nonce).toBe(7)
    })
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
