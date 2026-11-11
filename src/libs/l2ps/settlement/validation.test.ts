/**
 * The stateless half of settlement validation: the record's structure is
 * judged on its strings before any number is built from them, and the edits
 * a valid batch applies are derived from the transaction alone.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { getSharedState } from "@/utilities/sharedState"
import {
    MAX_SETTLEMENT_BATCHES_PER_BLOCK,
    parseSettlement,
    settlementBatchesOverCap,
    settlementEdits,
    settlementNonceRefusal,
    settlementSignatureRefusal,
} from "./validation"
import { CHAIN_ID, batchTx, key, recordOf, signedTransfer, vectors } from "./__fixtures__/settlementKit"

const ALICE = key(1)
const BOB = key(2)
const BURN = "0x" + "00".repeat(32)
const TREASURY = "0x" + "f7".repeat(32)
const savedDistribution = (getSharedState as any).feeDistribution

beforeEach(() => {
    ;(getSharedState as any).feeDistribution = {
        burnAddress: BURN,
        treasuryAddress: TREASURY,
        networkFee: { burnPct: 50, treasuryPct: 50 },
        additionalFee: { burnPct: 50, treasuryPct: 50 },
        specialOps: { burnPct: 50, rpcPct: 25, treasuryPct: 25 },
    }
})
afterEach(() => {
    ;(getSharedState as any).feeDistribution = savedDistribution
})

const t1 = signedTransfer({ from: ALICE, to: BOB.account, amount: 10n, fee: 4n, nonce: 5n })
const t2 = signedTransfer({ from: ALICE, to: BOB.account, amount: 1n, fee: 2n, nonce: 6n })

function parsed(record = recordOf([t1, t2])) {
    const out = parseSettlement(batchTx(record))
    if (!out.ok) throw new Error(out.reason)
    return out.value
}

describe("parseSettlement", () => {
    it("parses the vectors' signed transfers and verifies their signatures", () => {
        const transfers = vectors.transfers.slice(0, 2).map(v => ({
            commitment: v.commitment,
            signer: v.from,
            nonce: v.nonce,
            fee: v.fee,
            signature: v.signature,
        }))
        const record = {
            version: 1,
            transfers,
            changes: [
                { account: vectors.transfers[1].from, delta: "9000000000" },
                { account: vectors.transfers[0].from, delta: "-10000000000" },
            ],
            proof: {},
        }
        const out = parseSettlement(batchTx(record, { l2psUid: vectors.l2psUid }))
        expect(out.ok).toBe(true)
        if (out.ok) expect(settlementSignatureRefusal(out.value, vectors.chainId)).toBeNull()
    })

    it("refuses number-like strings that are not plain decimals before converting them", () => {
        for (const nonce of ["0x10", "1e3", " 5", "+5", "05", "-1"]) {
            const record = recordOf([t1]) as any
            record.transfers[0].nonce = nonce
            expect(parseSettlement(batchTx(record)).ok).toBe(false)
        }
        for (const delta of ["0x10", "1e3", "-0", "--1", "+1"]) {
            const record = recordOf([t1]) as any
            record.changes[0].delta = delta
            expect(parseSettlement(batchTx(record)).ok).toBe(false)
        }
    })

    it("refuses a commitment outside the field, upper-case hex and a fee past 2^53", () => {
        const big = recordOf([t1]) as any
        big.transfers[0].commitment = "0x" + "ff".repeat(32)
        expect(parseSettlement(batchTx(big))).toMatchObject({ ok: false })
        const upper = recordOf([t1]) as any
        upper.transfers[0].signer = upper.transfers[0].signer.toUpperCase().replace("0X", "0x")
        expect(parseSettlement(batchTx(upper)).ok).toBe(false)
        const fee = recordOf([t1]) as any
        fee.transfers[0].fee = (2n ** 53n).toString()
        expect(parseSettlement(batchTx(fee)).ok).toBe(false)
    })

    it("refuses another version", () => {
        const record = recordOf([t1]) as any
        record.version = 2
        expect(parseSettlement(batchTx(record))).toMatchObject({ ok: false, reason: "unsupported settlement version 2" })
    })
})

describe("settlementNonceRefusal", () => {
    it("wants each signer's nonces consecutive from its account nonce + 1", () => {
        expect(settlementNonceRefusal(parsed(), () => 4n)).toBeNull()
        expect(settlementNonceRefusal(parsed(), () => 3n)).toContain("next nonce 4")
        expect(settlementNonceRefusal(parsed(), () => 5n)).toContain("next nonce 6")
    })

    it("refuses a signature for another chain", () => {
        expect(settlementSignatureRefusal(parsed(), CHAIN_ID)).toBeNull()
        expect(settlementSignatureRefusal(parsed(), CHAIN_ID + 1)).toContain("does not verify")
        expect(settlementSignatureRefusal(parsed(), null)).toContain("no id")
    })
})

describe("settlementEdits", () => {
    it("applies the changes, spends the nonces and credits the fees without a second debit", () => {
        const edits = settlementEdits(parsed(), "batchhash") as any[]
        const balance = edits.filter(e => e.type === "balance")
        const removes = balance.filter(e => e.operation === "remove")
        expect(removes).toEqual([expect.objectContaining({ account: ALICE.account, amount: "17" })])
        expect(balance.find(e => e.account === BOB.account)).toMatchObject({ operation: "add", amount: "11" })
        expect(edits.filter(e => e.type === "nonce")).toEqual([
            expect.objectContaining({ account: ALICE.account, operation: "add", amount: 2 }),
        ])
        const credited = balance
            .filter(e => e.account === BURN || e.account === TREASURY)
            .reduce((s, e) => s + BigInt(e.amount), 0n)
        expect(credited).toBe(6n)
        expect(edits.every(e => e.txhash === "batchhash")).toBe(true)
    })
})

describe("settlementBatchesOverCap", () => {
    it("names every l2psBatch past the cap in the order given, ignoring other types", () => {
        const txs = Array.from({ length: MAX_SETTLEMENT_BATCHES_PER_BLOCK + 2 }, (_, i) => ({
            hash: `b${i}`,
            content: { type: i === 0 ? "native" : "l2psBatch" },
        }))
        expect([...settlementBatchesOverCap(txs)]).toEqual([`b${MAX_SETTLEMENT_BATCHES_PER_BLOCK + 1}`])
    })
})
