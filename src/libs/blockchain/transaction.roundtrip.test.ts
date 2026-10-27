/**
 * A syncing node checks each served body against the hash its block committed
 * to, so a stored transaction has to come back byte-for-byte as it was signed:
 * the bigint columns surface as strings and column order is not the signer's.
 */

import { describe, expect, it } from "bun:test"
import { makeSignedTx, newAccount } from "./testSupport/signedTx"

const { default: Transaction } = await import("./transaction")

const HEIGHT = 7

/** What the transactions table hands back for a stored row. */
function asStoredRow(tx: any) {
    const raw: any = Transaction.toRawTransaction(structuredClone(tx))
    return {
        ...raw,
        amount: BigInt(raw.amount),
        networkFee: BigInt(raw.networkFee),
        rpcFee: BigInt(raw.rpcFee),
        additionalFee: BigInt(raw.additionalFee),
        nonce: String(raw.nonce),
        timestamp: String(raw.timestamp),
    }
}

describe("Transaction.fromRawTransaction", () => {
    it("returns a stored transaction that still hashes to its hash", () => {
        const tx = makeSignedTx(newAccount(), newAccount(), { height: HEIGHT, nonce: 3 })

        const restored = Transaction.fromRawTransaction(asStoredRow(tx))

        expect(Transaction.isCoherent(restored, HEIGHT)).toBe(true)
        expect(JSON.stringify(restored.content)).toBe(JSON.stringify(tx.content))
    })

    it("keeps fields the columns do not carry", () => {
        const tx = makeSignedTx(newAccount(), newAccount(), { height: HEIGHT })
        tx.content.custom_charges = { storage: { gas_limit: "10" } }

        const restored = Transaction.fromRawTransaction(asStoredRow(tx))

        expect((restored.content as any).custom_charges).toEqual({
            storage: { gas_limit: "10" },
        })
    })
})
