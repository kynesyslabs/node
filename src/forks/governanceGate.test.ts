/**
 * The `networkGovernance` fork ships dormant, at genesis and at every height
 * until one is pinned: both governance transaction types, and any transaction
 * carrying a governance edit, are refused at RPC intake, at pool admission and
 * at block apply. Once active, a governance edit counts only for the account
 * that signed the transaction.
 *
 * The transactions come from the real SDK builders and signer, so the account
 * shape the gate compares is the one an honest validator ships.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"

let tip = 100
const chain = {
    __esModule: true,
    default: {
        getLastBlockNumber: async () => tip,
        getExistingTransactionHashes: async () => new Set<string>(),
    },
}
mock.module("src/libs/blockchain/chain", () => chain)
mock.module("@/libs/blockchain/chain", () => chain)
const governanceWrites: string[] = []
mock.module("@/libs/blockchain/gcr/gcr_routines/GCRNetworkUpgradeRoutines", () => ({
    __esModule: true,
    default: {
        applyProposal: async (edit: { account: string }) => {
            governanceWrites.push(`proposal ${edit.account}`)
            return { success: true, message: "Proposal persisted" }
        },
        applyVote: async (edit: { account: string }) => {
            governanceWrites.push(`vote ${edit.account}`)
            return { success: true, message: "Vote persisted" }
        },
    },
}))
mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: () => {},
        info: () => {},
        warning: () => {},
        error: () => {},
        only: () => {},
        custom: () => {},
    },
}))

import { readFileSync } from "node:fs"
import { DemosTransactions } from "@kynesyslabs/demosdk/websdk"
import type { Transaction } from "@kynesyslabs/demosdk/types"
import { isForkActive } from "@/forks/forkGates"
import { DEFAULT_FORK_CONFIG, cloneDefaultForkConfig, type ForkConfigByName } from "@/forks/forkConfig"
import { loadForkConfigFromGenesis } from "@/forks/loadForkConfig"
import { carriesGovernance, governanceGateRefusal } from "@/forks/governanceGate"
import { getSharedState } from "@/utilities/sharedState"
import { verifyAdmissionEdits, verifyRpcEdits } from "@/libs/blockchain/validation/editBinding"
import { PEER, SENDER, VICTIM, demos, onTheWire } from "@/libs/blockchain/validation/editBinding.fixtures"
import type { GCREntityCaches } from "@/libs/blockchain/gcr/handleGCR"

const { default: HandleGCR } = await import("@/libs/blockchain/gcr/handleGCR")
const { handleGovernanceTx } = await import("@/libs/network/routines/transactions/handleGovernanceTx")

const PROPOSAL_ID = "11111111-1111-4111-8111-111111111111"

const builders = {
    vote: () => DemosTransactions.voteOnUpgrade(PROPOSAL_ID, true, demos),
    proposal: () =>
        DemosTransactions.proposeNetworkUpgrade(
            {
                proposalId: PROPOSAL_ID,
                proposedParameters: { networkFee: 2 } as never,
                rationale: "raise the fee",
                effectiveAtBlock: 5000,
            },
            demos,
        ),
    pay: () => DemosTransactions.pay(PEER, 3n, demos),
}

async function wire(kind: keyof typeof builders): Promise<Transaction> {
    return onTheWire(await builders[kind]())
}

const edits = (tx: Transaction) => tx.content.gcr_edits as unknown as Array<Record<string, any>>
const governanceEdit = (tx: Transaction) =>
    edits(tx).find(e => e.type === "networkUpgrade" || e.type === "networkUpgradeVote")!

/** A vote edit for `account` slipped into an otherwise honest payment. */
async function smuggledVote(account = SENDER): Promise<Transaction> {
    const tx = await wire("pay")
    edits(tx).push({ type: "networkUpgradeVote", isRollback: false, account, proposalId: PROPOSAL_ID, approve: true, txhash: "" })
    return tx
}

/** editBinding at `editBinding`, networkGovernance at `governance`, tip 100. */
function forks(governance: number | null, editBinding: number | null = null) {
    getSharedState.forkConfig = cloneDefaultForkConfig()
    getSharedState.forkConfig.osDenomination.activationHeight = 0
    getSharedState.forkConfig.nonceEnforcement.activationHeight = null
    getSharedState.forkConfig.gasFeeSeparation.activationHeight = null
    getSharedState.forkConfig.editBinding.activationHeight = editBinding
    getSharedState.forkConfig.networkGovernance.activationHeight = governance
    getSharedState.lastBlockNumber = 100
    tip = 100
}

let saved: ForkConfigByName
beforeEach(() => {
    saved = getSharedState.forkConfig
})
afterEach(() => {
    getSharedState.forkConfig = saved
})

describe("networkGovernance fork config", () => {
    beforeEach(() => {
        getSharedState.forkConfig = cloneDefaultForkConfig()
    })

    it("is inactive by default, at genesis and at every height", () => {
        expect(DEFAULT_FORK_CONFIG.networkGovernance.activationHeight).toBeNull()
        expect(cloneDefaultForkConfig().networkGovernance.activationHeight).toBeNull()
        expect(isForkActive("networkGovernance", 0)).toBe(false)
        expect(isForkActive("networkGovernance", 1_000_000)).toBe(false)
    })

    it("stays inactive when genesis does not mention it", () => {
        loadForkConfigFromGenesis({ forks: { editBinding: { activationHeight: 0 } } })
        expect(isForkActive("networkGovernance", 1_000_000)).toBe(false)
    })

    it("activates only from a pinned height", () => {
        loadForkConfigFromGenesis({ forks: { networkGovernance: { activationHeight: 500 } } })
        expect(isForkActive("networkGovernance", 499)).toBe(false)
        expect(isForkActive("networkGovernance", 500)).toBe(true)
    })

    it("is left unscheduled by the mainnet template and active from block 0 on devnet", () => {
        const template = JSON.parse(readFileSync("docs/mainnet/genesis.template.json", "utf8"))
        expect(template.forks.networkGovernance).toEqual({ activationHeight: null })
        const devnet = JSON.parse(readFileSync("testing/devnet/genesis.devnet.json", "utf8"))
        expect(devnet.forks.networkGovernance).toEqual({ activationHeight: 0 })
    })
})

describe("governanceGateRefusal", () => {
    it("leaves a transaction without governance alone, active or not", async () => {
        const tx = await wire("pay")
        expect(carriesGovernance(tx)).toBe(false)
        expect(governanceGateRefusal(tx, false)).toBeNull()
        expect(governanceGateRefusal(tx, true)).toBeNull()
    })

    it("refuses both governance types and a smuggled governance edit while inactive", async () => {
        for (const tx of [await wire("vote"), await wire("proposal"), await smuggledVote()]) {
            expect(governanceGateRefusal(tx, false)).toContain("not active")
        }
    })

    it("refuses a governance type even when it carries no governance edit", async () => {
        const tx = await wire("vote")
        tx.content.gcr_edits = edits(tx).filter(e => e.type !== "networkUpgradeVote") as never
        expect(governanceGateRefusal(tx, false)).toContain("not active")
    })

    it("accepts what the SDK builds once active: the edit names the signer as from_ed25519_address", async () => {
        for (const kind of ["vote", "proposal"] as const) {
            const tx = await wire(kind)
            expect(governanceEdit(tx).account).toBe(tx.content.from_ed25519_address)
            expect(governanceEdit(tx).account).toBe(SENDER)
            expect(governanceEdit(tx).account).toMatch(/^0x[0-9a-f]{64}$/)
            expect(governanceGateRefusal(tx, true)).toBeNull()
        }
    })

    it("compares accounts the way the governance rows store them, lower-cased", async () => {
        const tx = await wire("vote")
        governanceEdit(tx).account = "0x" + SENDER.slice(2).toUpperCase()
        expect(governanceGateRefusal(tx, true)).toBeNull()
    })

    it("refuses, once active, a vote or proposal recorded under another validator", async () => {
        for (const kind of ["vote", "proposal"] as const) {
            const tx = await wire(kind)
            governanceEdit(tx).account = VICTIM
            expect(governanceGateRefusal(tx, true)).toContain("another account than the signer")
        }
    })

    it("refuses, once active, an edit without the 0x prefix the SDK always writes", async () => {
        const tx = await wire("vote")
        governanceEdit(tx).account = SENDER.slice(2)
        expect(governanceGateRefusal(tx, true)).toContain("another account than the signer")
    })

    it("refuses, once active, a governance edit carried by another transaction type", async () => {
        expect(governanceGateRefusal(await smuggledVote(), true)).toContain("carried by a native transaction")
        const vote = await wire("vote")
        edits(vote).push({ ...governanceEdit(await wire("proposal")) })
        expect(governanceGateRefusal(vote, true)).toContain("networkUpgrade edit carried by a networkUpgradeVote")
    })
})

describe("RPC intake", () => {
    it("refuses both governance types while the fork is dormant", async () => {
        forks(null)
        for (const kind of ["vote", "proposal"] as const) {
            const tx = await wire(kind)
            expect((await handleGovernanceTx(tx)).message).toContain("not active")
            expect((await verifyRpcEdits(tx)).ok).toBe(false)
        }
    })

    it("refuses a governance edit smuggled into another type, with or without editBinding", async () => {
        for (const editBinding of [null, 0]) {
            forks(null, editBinding)
            expect((await verifyRpcEdits(await smuggledVote())).reason).toContain("not active")
        }
    })

    it("judges the block the transaction would land in, from the tip", async () => {
        forks(101)
        const tx = await wire("vote")
        expect((await verifyRpcEdits(tx)).ok).toBe(false)
        tip = 101
        expect((await verifyRpcEdits(tx)).ok).toBe(true)
    })

    it("once active, refuses a vote under another validator before reading any state", async () => {
        forks(0)
        const tx = await wire("vote")
        governanceEdit(tx).account = VICTIM
        expect((await handleGovernanceTx(tx)).message).toContain("another account than the signer")
        expect((await verifyRpcEdits(tx)).ok).toBe(false)
    })

    it("once active, accepts the SDK's own vote", async () => {
        forks(0)
        expect(await verifyRpcEdits(await wire("vote"))).toEqual({ ok: true })
    })
})

describe("pool admission", () => {
    it("refuses governance while dormant, whether or not editBinding is active", async () => {
        for (const editBinding of [null, 0]) {
            forks(null, editBinding)
            for (const tx of [await wire("vote"), await wire("proposal"), await smuggledVote()]) {
                const verdict = await verifyAdmissionEdits(tx)
                expect(verdict.ok).toBe(false)
                expect(verdict.reason).toContain("not active")
            }
        }
    })

    it("once active, refuses a mismatched account and admits the signer's own", async () => {
        for (const editBinding of [null, 0]) {
            forks(0, editBinding)
            const forged = await wire("vote")
            governanceEdit(forged).account = VICTIM
            expect((await verifyAdmissionEdits(forged)).reason).toContain("another account than the signer")
            expect(await verifyAdmissionEdits(await wire("vote"))).toEqual({ ok: true })
            expect(await verifyAdmissionEdits(await wire("proposal"))).toEqual({ ok: true })
        }
    })
})

describe("block apply", () => {
    let caches: GCREntityCaches
    const original = {
        prepareEntities: HandleGCR.prepareEntities,
        saveGCREditChanges: HandleGCR.saveGCREditChanges,
        bulkUpdateAssignedTxs: HandleGCR.bulkUpdateAssignedTxs,
        stagedGovernanceRepos: HandleGCR.stagedGovernanceRepos,
    }
    const refuseUnboundEdits = (txs: Transaction[]): Promise<Set<string>> =>
        (HandleGCR as any).refuseUnboundEdits(txs, false, 101)

    beforeEach(() => {
        const account = (pubkey: string) => [pubkey, { pubkey, balance: 1_000_000_000_000n, nonce: 7 } as any] as const
        caches = {
            accounts: new Map([account(SENDER), account(VICTIM), account(PEER)]),
            storagePrograms: new Map(),
            tlsNotaries: new Map(),
            atomicWorks: new Map(),
            resourceSlots: new Map(),
        }
        ;(HandleGCR as any).prepareEntities = async () => caches
        ;(HandleGCR as any).saveGCREditChanges = async () => {}
        ;(HandleGCR as any).bulkUpdateAssignedTxs = async () => {}
        ;(HandleGCR as any).stagedGovernanceRepos = () => ({ proposals: {}, votes: {} })
        governanceWrites.length = 0
    })
    afterEach(() => {
        Object.assign(HandleGCR, original)
    })

    it("fails a dormant-fork governance transaction in a block and applies none of its edits", async () => {
        for (const editBinding of [null, 0]) {
            forks(null, editBinding)
            caches.accounts.get(SENDER).nonce = 7
            const vote = await wire("vote")
            const smuggled = await smuggledVote(VICTIM)

            const out = await HandleGCR.applyTransactions([vote, smuggled], false, { height: 101, timestampSec: 1 })

            expect(out.failedTxs).toEqual([vote.hash, smuggled.hash])
            expect(out.successfulTxs).toEqual([])
            expect(caches.accounts.get(SENDER).nonce).toBe(7)
            expect(governanceWrites).toEqual([])
        }
    })

    it("once active, applies the signer's own vote in a block", async () => {
        forks(0)
        const vote = await wire("vote")

        const out = await HandleGCR.applyTransactions([vote], false, { height: 101, timestampSec: 1 })

        expect(out.successfulTxs).toEqual([vote.hash])
        expect(governanceWrites).toEqual([`vote ${SENDER}`])
    })

    it("refuses the same transactions in the pre-pass on every node, from the tip", async () => {
        forks(101)
        const vote = await wire("vote")
        expect([...(await refuseUnboundEdits([vote]))]).toEqual([vote.hash])
        tip = 101
        expect([...(await refuseUnboundEdits([vote]))]).toEqual([])
    })

    it("once active, refuses a mismatched account and passes the signer's own", async () => {
        for (const editBinding of [null, 0]) {
            forks(0, editBinding)
            const honest = await wire("vote")
            const forged = await wire("proposal")
            governanceEdit(forged).account = VICTIM
            expect([...(await refuseUnboundEdits([honest, forged]))]).toEqual([forged.hash])
        }
    })

    it("refuses a governance edit applied one transaction at a time, as L2PS proofs are", async () => {
        forks(0)
        const proof = {
            hash: "ab".repeat(32),
            content: {
                type: "l2psEncryptedTx",
                from: SENDER,
                from_ed25519_address: SENDER,
                gcr_edits: [{ type: "networkUpgradeVote", isRollback: false, account: SENDER, proposalId: PROPOSAL_ID, approve: true, txhash: "" }],
            },
        } as unknown as Transaction
        const result = await HandleGCR.applyTransaction(caches, proof, false, false)
        expect(result.success).toBe(false)
        expect(result.message).toContain("carried by a l2psEncryptedTx transaction")

        forks(null)
        const simulated = await HandleGCR.applyTransaction(caches, await wire("vote"), false, true)
        expect(simulated.success).toBe(false)
        expect(simulated.message).toContain("not active")
    })
})
