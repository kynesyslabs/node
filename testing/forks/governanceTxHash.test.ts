/**
 * kynesyslabs/node#941: a governance propose signed by the SDK was refused at
 * confirm with "Transaction hash mismatch". The node now derives the hash of
 * post-osDenomination content with the SDK's own serializer
 * (src/libs/crypto/txContentSerializer.ts), so the two cannot disagree on a
 * governance transaction.
 *
 * This pins that end to end on the node side: a propose and a vote are built
 * and signed by the real SDK builders (proposeNetworkUpgrade, voteOnUpgrade),
 * with the payload reported in the issue, and must pass the RPC coherence
 * check (Transaction.checkCoherence) and the mempool admission check
 * (validateTx) with osDenomination on and off. A propose edited after signing
 * must be refused. Only the SDK's network lookups are stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test"

// The edit binding reads the chain tip; the mocks are the ones
// src/libs/blockchain/validation/editBinding.test.ts uses.
const TIP = 100
mock.module("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getLastBlockNumber: async () => TIP },
}))
mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: () => {},
        info: () => {},
        warning: () => {},
        error: () => {},
        only: () => {},
    },
}))

import { Demos, DemosTransactions } from "@kynesyslabs/demosdk/websdk"
import type { Transaction } from "@kynesyslabs/demosdk/types"
import TransactionClass from "@/libs/blockchain/transaction"
import { validateTx } from "@/libs/blockchain/validation/txValidator"
import { verifyAdmissionEdits } from "@/libs/blockchain/validation/editBinding"
import { cloneDefaultForkConfig, type ForkConfigByName } from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"

// Test-only wallet, the BIP39 all-zero-entropy vector.
const MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art"
const CHAIN_ID = 1337
const OS_DENOMINATION_HEIGHT = 10
const PRE_FORK_HEIGHT = 5

// The propose captured in #941 (scripts/governance-diag.ts).
const ISSUE_PROPOSAL = {
    proposalId: "9cfe50df-09dd-44d1-9fd2-8d83f97b25ac",
    proposedParameters: { blockTimeMs: 1100 },
    rationale: "diag: capture hash inputs",
    effectiveAtBlock: 9054,
}

/** A wallet whose node lookups answer as a node with the given fork state. */
async function sdkSigner(osDenomination: boolean): Promise<Demos> {
    const demos = new Demos()
    await demos.connectWallet(MNEMONIC)
    const stubs = demos as unknown as Record<string, unknown>
    stubs.rpc_url = "http://stub.invalid"
    stubs.getNetworkInfo = async () => ({
        chainId: CHAIN_ID,
        forks: {
            osDenomination: { activated: osDenomination },
            signatureDomain: { activated: true },
        },
    })
    // Fees as the node reports them (DEM numbers), as in the issue payload.
    stubs._getNetworkParametersCached = async () => ({ networkFee: 1, rpcFee: 1 })
    stubs.getAddressNonce = async () => 0
    return demos
}

function admit(tx: Transaction, osDenomination: boolean) {
    const height = osDenomination ? OS_DENOMINATION_HEIGHT : PRE_FORK_HEIGHT
    return {
        rpc: TransactionClass.checkCoherence(tx, height),
        mempool: validateTx(tx, null, osDenomination, {
            active: true,
            chainId: CHAIN_ID,
        }),
    }
}

describe("#941: SDK-signed governance transactions pass node admission", () => {
    let snapshot: ForkConfigByName
    beforeEach(() => {
        snapshot = getSharedState.forkConfig
        getSharedState.forkConfig = cloneDefaultForkConfig()
        getSharedState.forkConfig.osDenomination.activationHeight =
            OS_DENOMINATION_HEIGHT
    })
    afterEach(() => {
        getSharedState.forkConfig = snapshot
    })

    for (const osDenomination of [true, false]) {
        const label = `osDenomination ${osDenomination ? "on" : "off"}`

        it(`${label}: a propose with the issue's payload is coherent and admitted`, async () => {
            const demos = await sdkSigner(osDenomination)
            const tx = (await DemosTransactions.proposeNetworkUpgrade(
                ISSUE_PROPOSAL,
                demos,
                { nonce: 1 },
            )) as Transaction

            expect(tx.content.type).toBe("networkUpgrade")
            expect(tx.content.data).toEqual(["networkUpgrade", ISSUE_PROPOSAL])
            // The wire shape the issue captured: OS strings post-fork only.
            expect(tx.content.transaction_fee.network_fee).toEqual(
                osDenomination ? "1000000000" : 1,
            )

            const { rpc, mempool } = admit(tx, osDenomination)
            expect(rpc).toEqual({ coherent: true })
            expect(await mempool).toEqual({ hash: tx.hash, valid: true })
        })

        it(`${label}: a vote is coherent and admitted`, async () => {
            const demos = await sdkSigner(osDenomination)
            const tx = (await DemosTransactions.voteOnUpgrade(
                ISSUE_PROPOSAL.proposalId,
                true,
                demos,
                { nonce: 2 },
            )) as Transaction

            expect(tx.content.type).toBe("networkUpgradeVote")
            const { rpc, mempool } = admit(tx, osDenomination)
            expect(rpc).toEqual({ coherent: true })
            expect(await mempool).toEqual({ hash: tx.hash, valid: true })
        })

        it(`${label}: a propose edited after signing is refused`, async () => {
            const demos = await sdkSigner(osDenomination)
            const tx = (await DemosTransactions.proposeNetworkUpgrade(
                ISSUE_PROPOSAL,
                demos,
                { nonce: 1 },
            )) as Transaction
            const payload = (tx.content.data as [string, { effectiveAtBlock: number }])[1]
            payload.effectiveAtBlock += 1

            const { rpc, mempool } = admit(tx, osDenomination)
            expect(rpc).toEqual({
                coherent: false,
                reason: "Transaction hash mismatch",
            })
            expect((await mempool).valid).toBe(false)
            expect((await mempool).reason).toBe("Transaction is not coherent")

            // Re-hashing the edit makes it coherent, but the signature no
            // longer covers it.
            TransactionClass.hash(
                tx,
                osDenomination ? OS_DENOMINATION_HEIGHT : PRE_FORK_HEIGHT,
            )
            const rehashed = admit(tx, osDenomination)
            expect(rehashed.rpc).toEqual({ coherent: true })
            expect((await rehashed.mempool).reason).toBe(
                "Transaction signature verification failed",
            )
        })
    }

    // The node hashes any wire form of the content the way the SDK does, not
    // only the exact bytes the builder emits. Before #1074 the node's own
    // post-fork serializer passed gcr_edits amounts through as sent, so a
    // propose whose fee edit was written in DEM failed with "Transaction hash
    // mismatch".
    //
    // This form passes only the hash and signature checks. Edit binding
    // refuses it: it compares a shipped amount in the shape apply uses (see
    // the module comment of src/libs/blockchain/validation/editBinding.ts),
    // and apply would read the number as OS (BigInt(amount) in
    // GCRBalanceRoutines), as editBinding.test.ts already pins ("refuses a
    // gas edit shipped as a DEM number after osDenomination"). Here it is
    // refused at peer admission with editBinding dormant.
    it("osDenomination on: a propose whose fee edit is written in DEM still hashes and verifies as the SDK signed it", async () => {
        const demos = await sdkSigner(true)
        const tx = (await DemosTransactions.proposeNetworkUpgrade(
            ISSUE_PROPOSAL,
            demos,
            { nonce: 1 },
        )) as Transaction
        const fee = tx.content.gcr_edits.find(
            e => e.type === "balance" && e.operation === "remove",
        ) as { amount: unknown }
        expect(fee.amount).toBe("1000000000")

        // Governance on, so the edit check alone decides; the canonical
        // form passes it.
        getSharedState.forkConfig.networkGovernance.activationHeight = 0
        expect(getSharedState.forkConfig.editBinding.activationHeight).toBeNull()
        expect(await verifyAdmissionEdits(tx)).toEqual({ ok: true })

        // A number here is OS at apply, so this is not the same value.
        fee.amount = 1

        const { rpc, mempool } = admit(tx, true)
        expect(rpc).toEqual({ coherent: true })
        expect(await mempool).toEqual({ hash: tx.hash, valid: true })

        const edits = await verifyAdmissionEdits(tx)
        expect(edits.ok).toBe(false)
        expect(edits.reason).toStartWith(
            "value edits with no counterpart in the regenerated set",
        )
    })
})
