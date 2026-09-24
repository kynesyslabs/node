import { beforeAll, describe, expect, it } from "bun:test"

import { getSharedState } from "@/utilities/sharedState"

const { withDerivedFeeEdits } = await import("@/libs/blockchain/gcr/handleGCR")

const SENDER = "0x" + "6d".repeat(32)
const TO = "0x" + "f8".repeat(32)

function signedTransfer(): any {
    return {
        hash: "0x" + "ab".repeat(32),
        content: {
            type: "native",
            from: SENDER,
            to: TO,
            transaction_fee: {
                network_fee: "1000000000",
                rpc_fee: "1000000000",
                additional_fee: "0",
                rpc_address: null,
            },
            gcr_edits: [
                { type: "balance", operation: "remove", account: SENDER, amount: 1000, isRollback: false, txhash: "" },
                { type: "balance", operation: "add", account: TO, amount: 1000, isRollback: false, txhash: "" },
                { type: "nonce", operation: "add", account: SENDER, amount: 1, isRollback: false, txhash: "" },
            ],
        },
    }
}

beforeAll(() => {
    const state = getSharedState as any
    state.forkConfig = { ...(state.forkConfig ?? {}), gasFeeSeparation: { activationHeight: 0 } }
    state.lastBlockNumber = 10
    state.feeDistribution = {
        burnAddress: "0x" + "00".repeat(32),
        treasuryAddress: "0x" + "f7".repeat(32),
        networkFee: { burnPct: 50, treasuryPct: 50 },
        additionalFee: { burnPct: 50, treasuryPct: 50 },
        specialOps: { burnPct: 50, rpcPct: 25, treasuryPct: 25 },
    }
})

describe("withDerivedFeeEdits", () => {
    it("puts the fee edits in front on a copy and leaves the signed tx alone", () => {
        const tx = signedTransfer()
        const out = withDerivedFeeEdits(tx)

        expect(out).not.toBe(tx)
        expect(tx.content.gcr_edits.length).toBe(3)
        expect(out.content.gcr_edits.length).toBeGreaterThan(3)
        expect(out.content.gcr_edits.slice(-3)).toEqual(tx.content.gcr_edits)
        expect(out.hash).toBe(tx.hash)
    })

    it("derives the same edits when a synced node applies what the producer served", () => {
        // The producer applies, then persists and serves the tx it was given.
        const producerTx = signedTransfer()
        const producerApplied = withDerivedFeeEdits(producerTx)
        const served = JSON.parse(JSON.stringify(producerTx))

        const syncerApplied = withDerivedFeeEdits(served)
        expect(syncerApplied.content.gcr_edits).toEqual(producerApplied.content.gcr_edits)
    })

    it("does not add the fee edits twice to a tx stored with them already", () => {
        const legacyRow = withDerivedFeeEdits(signedTransfer())
        const again = withDerivedFeeEdits(JSON.parse(JSON.stringify(legacyRow)))

        expect(again.content.gcr_edits.length).toBe(legacyRow.content.gcr_edits.length)
    })

    it("leaves a tx that owes no fee untouched", () => {
        const tx = signedTransfer()
        tx.content.transaction_fee = { network_fee: "0", rpc_fee: "0", additional_fee: "0", rpc_address: null }
        expect(withDerivedFeeEdits(tx)).toBe(tx)
    })
})
