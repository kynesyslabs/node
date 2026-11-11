/**
 * Opening and admitting a member-decrypted settlement transfer: the SDK
 * shape (shared vectors), the old format refused with a clear error, and
 * the admission rules (signature, fee floor, unspent nonce).
 */
import { describe, expect, it } from "bun:test"
import { fieldToHex } from "./encoding"
import { openSettlementTransfer, transferAdmissionRefusal } from "./transfer"
import { CHAIN_ID, UID, innerTx, key, signedTransfer, vectors } from "./__fixtures__/settlementKit"

const ALICE = key(1)
const BOB = key(2)

function vectorInner(i: number) {
    const v = vectors.transfers[i]
    return {
        hash: `inner_${i}`,
        content: {
            type: "native",
            from: v.from,
            // The last vector's nonce is 2^64 - 1, past a safe JS number.
            nonce: v.nonce as string | number,
            data: [
                "native",
                {
                    nativeOperation: "send",
                    args: [v.to, v.amount],
                    l2ps_uid: UID,
                    settlement: { fee: v.fee, salt: v.salt, commitment: v.commitment, signature: v.signature },
                },
            ],
        },
    }
}

const admission = (minimumFee: bigint, accountNonce: bigint) => ({
    chainId: CHAIN_ID,
    l2psUid: UID,
    minimumFee,
    accountNonce,
})

describe("openSettlementTransfer", () => {
    it("opens the SDK vectors and recomputes their commitments", () => {
        for (const [i, v] of vectors.transfers.entries()) {
            const out = openSettlementTransfer(vectorInner(i), `enc_${i}`)
            expect(out.ok).toBe(true)
            if (!out.ok) continue
            expect(out.transfer.txHash).toBe(`enc_${i}`)
            expect(out.transfer.from).toBe(v.from)
            expect(out.transfer.to).toBe(v.to)
            expect(out.transfer.amount).toBe(BigInt(v.amount))
            expect(fieldToHex(out.transfer.commitment)).toBe(v.commitment)
            expect(transferAdmissionRefusal(out.transfer, admission(0n, 0n))).toBeNull()
        }
    })

    it("refuses the format before the fork with an error that names the SDK", () => {
        const old = vectorInner(0)
        delete (old.content.data[1] as any).settlement
        const out = openSettlementTransfer(old, "enc")
        expect(out.ok).toBe(false)
        if (out.ok !== false) return
        expect(out.reason).toContain("old-format L2PS transfer")
        expect(out.reason).toContain("update the SDK")
    })

    it("refuses a commitment that does not open to the decrypted fields", () => {
        const tampered = vectorInner(0)
        ;(tampered.content.data[1] as any).args[1] = "10000000001"
        const out = openSettlementTransfer(tampered, "enc")
        expect(out).toEqual({ ok: false, reason: "settlement commitment does not open to the decrypted transfer" })
    })

    it("refuses a salt of 2^248 or more and non-canonical accounts", () => {
        const bigSalt = vectorInner(0)
        ;(bigSalt.content.data[1] as any).settlement.salt = "0x01" + "00".repeat(31)
        expect(openSettlementTransfer(bigSalt, "enc")).toMatchObject({ ok: false, reason: "settlement salt is not below 2^248" })

        const upper = vectorInner(0)
        upper.content.from = upper.content.from.toUpperCase().replace("0X", "0x")
        expect(openSettlementTransfer(upper, "enc").ok).toBe(false)
    })

    it("refuses an amount that is not a decimal string", () => {
        const numeric = vectorInner(0)
        ;(numeric.content.data[1] as any).args[1] = 10
        expect(openSettlementTransfer(numeric, "enc")).toMatchObject({ ok: false, reason: "amount must be an OS decimal string" })
    })

    it("refuses a transfer that is not a native send", () => {
        const other = vectorInner(0)
        other.content.type = "storage"
        expect(openSettlementTransfer(other, "enc").ok).toBe(false)
    })
})

describe("transferAdmissionRefusal", () => {
    const transfer = signedTransfer({ from: ALICE, to: BOB.account, amount: 5n, fee: 3_000_000_000n, nonce: 4n })

    it("admits a signed transfer at the fee floor with the next nonce", () => {
        const opened = openSettlementTransfer(innerTx(transfer), transfer.txHash)
        expect(opened.ok).toBe(true)
        expect(transferAdmissionRefusal(transfer, admission(3_000_000_000n, 3n))).toBeNull()
    })

    it("accepts a nonce ahead of the next one; the planner orders them", () => {
        expect(transferAdmissionRefusal(transfer, admission(0n, 1n))).toBeNull()
    })

    it("refuses a fee below the native transfer fee", () => {
        expect(transferAdmissionRefusal(transfer, admission(3_000_000_001n, 3n))).toContain("below the native transfer fee")
    })

    it("refuses a nonce the account already spent", () => {
        expect(transferAdmissionRefusal(transfer, admission(0n, 4n))).toContain("already spent")
    })

    it("refuses a signature by another key, for another chain or another subnet", () => {
        const forged = { ...transfer, signature: signedTransfer({ from: BOB, to: BOB.account, amount: 5n, fee: 3_000_000_000n, nonce: 4n }).signature }
        expect(transferAdmissionRefusal(forged, admission(0n, 0n))).toBe("settlement signature does not verify for the sender")
        expect(transferAdmissionRefusal(transfer, { ...admission(0n, 0n), chainId: CHAIN_ID + 1 })).toBe(
            "settlement signature does not verify for the sender",
        )
        expect(transferAdmissionRefusal(transfer, { ...admission(0n, 0n), l2psUid: "other" })).toBe(
            "settlement signature does not verify for the sender",
        )
        expect(transferAdmissionRefusal(transfer, { ...admission(0n, 0n), chainId: null })).toContain("declares no id")
    })
})
