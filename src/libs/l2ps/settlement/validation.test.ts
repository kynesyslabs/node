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
    settlementCoverageRefusal,
    settlementEdits,
    settlementNonceRefusal,
    settlementSignatureRefusal,
    settlementStateRefusal,
} from "./validation"
import { CHAIN_ID, UID, batchTx, key, recordOf, signedTransfer, vectors } from "./__fixtures__/settlementKit"
import type { GCRMain } from "@/model/entities/GCRv2/GCR_Main"

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
    if (out.ok === false) throw new Error(out.reason)
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

    it("refuses a version no string can be made of, instead of throwing", () => {
        const record = recordOf([t1]) as any
        record.version = JSON.parse('{"toString": null}')
        expect(parseSettlement(batchTx(record))).toMatchObject({ ok: false, reason: "unsupported settlement version object" })
    })
})

describe("settlementNonceRefusal", () => {
    it("wants each signer's nonces consecutive from its L2PS nonce + 1", () => {
        expect(settlementNonceRefusal(parsed(), () => 4n)).toBeNull()
        expect(settlementNonceRefusal(parsed(), () => 3n)).toContain("next L2PS nonce 4")
        expect(settlementNonceRefusal(parsed(), () => 5n)).toContain("next L2PS nonce 6")
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
        // The L2PS nonce of the batch's subnet, never the L1 nonce.
        expect(edits.filter(e => e.type === "nonce")).toEqual([])
        expect(edits.filter(e => e.type === "l2psNonce")).toEqual([
            {
                type: "l2psNonce",
                operation: "add",
                account: ALICE.account,
                l2psUid: UID,
                amount: 2,
                txhash: "batchhash",
                isRollback: false,
            },
        ])
        const credited = balance
            .filter(e => e.account === BURN || e.account === TREASURY)
            .reduce((s, e) => s + BigInt(e.amount), 0n)
        expect(credited).toBe(6n)
        expect(edits.every(e => e.txhash === "batchhash")).toBe(true)
    })
})

describe("settlementCoverageRefusal", () => {
    // ALICE: -17 (amounts 11, fees 6), BOB: +11.
    it("wants each account's balance to cover its net change, and only that", () => {
        const balances = (alice: bigint) => (a: string) => (a === ALICE.account ? alice : 0n)
        expect(settlementCoverageRefusal(parsed(), balances(17n))).toBeNull()
        expect(settlementCoverageRefusal(parsed(), balances(16n))).toContain("does not cover its net change -17")
    })

    it("lets a transfer be paid from a credit of the same batch", () => {
        // BOB pays ALICE 15 + 1 out of the 10 ALICE sends him first: BOB's
        // net is -6, so 6 covers it although 15 + 1 is more than 6.
        const out = signedTransfer({ from: ALICE, to: BOB.account, amount: 10n, fee: 1n, nonce: 1n })
        const back = signedTransfer({ from: BOB, to: ALICE.account, amount: 15n, fee: 1n, nonce: 1n })
        const settlement = parsed(recordOf([out, back]))
        const delta = (a: string) => settlement.changes.find(c => c.account === a)!.delta
        expect(delta(BOB.account)).toBe(-6n)
        expect(delta(ALICE.account)).toBe(4n)
        const balances = (bob: bigint) => (a: string) => (a === BOB.account ? bob : 0n)
        expect(settlementCoverageRefusal(settlement, balances(6n))).toBeNull()
        expect(settlementCoverageRefusal(settlement, balances(5n))).toContain("does not cover")
    })
})

describe("settlementStateRefusal", () => {
    const row = (fields: Partial<GCRMain>) => fields as GCRMain
    const accounts = (alice: Partial<GCRMain>) => new Map([[ALICE.account, row(alice)]])

    it("reads the L2PS nonce of the batch's subnet, never the L1 nonce", async () => {
        // L1 nonce 4 would make 5 the next nonce; the L2PS nonce 0 wants 1.
        const refusal = await settlementStateRefusal(parsed(), accounts({ nonce: 4, balance: 100n as never }))
        expect(refusal).toContain("next L2PS nonce 1")
        // Another subnet's L2PS nonce is no nonce here.
        const other = await settlementStateRefusal(
            parsed(),
            accounts({ nonce: 0, balance: 100n as never, l2psNonces: { other_subnet: 4 } }),
        )
        expect(other).toContain("next L2PS nonce 1")
    })

    it("refuses an account that cannot cover its net change before checking the proof", async () => {
        const refusal = await settlementStateRefusal(
            parsed(),
            accounts({ nonce: 0, balance: 16n as never, l2psNonces: { [UID]: 4 } }),
        )
        expect(refusal).toContain("does not cover its net change -17")
    })

    it("does not read a subnet uid off the prototype", async () => {
        const settlement = { ...parsed(), l2psUid: "__proto__" }
        const refusal = await settlementStateRefusal(
            settlement,
            accounts({ nonce: 0, balance: 100n as never, l2psNonces: {} }),
        )
        expect(refusal).toContain("next L2PS nonce 1")
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
