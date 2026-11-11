import { describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import vectors from "./__fixtures__/settlementVectors.json"
import {
    accountLimbs,
    commitmentsHash,
    fieldToHex,
    parseDelta,
    settlementCommitment,
    settlementPublicSignals,
    settlementSignatureMessage,
    SETTLEMENT_PUBLIC_SIGNALS,
} from "./encoding"

const A = "0x" + "11".repeat(32)
const B = "0x" + "22".repeat(32)

describe("settlement vectors (shared with the SDK)", () => {
    for (const [i, v] of vectors.transfers.entries()) {
        it(`transfer ${i}: commitment, message and signature`, () => {
            const c = settlementCommitment({
                from: v.from,
                to: v.to,
                amount: BigInt(v.amount),
                fee: BigInt(v.fee),
                nonce: BigInt(v.nonce),
                salt: BigInt(v.salt),
            })
            expect(fieldToHex(c)).toBe(v.commitment)
            const message = settlementSignatureMessage(vectors.chainId, vectors.l2psUid, c)
            expect(new TextDecoder().decode(message)).toBe(v.message)
            const spki = Buffer.concat([
                Buffer.from("302a300506032b6570032100", "hex"),
                Buffer.from(v.from.slice(2), "hex"),
            ])
            const key = crypto.createPublicKey({ key: spki, format: "der", type: "spki" })
            expect(
                crypto.verify(null, Buffer.from(message), key, Buffer.from(v.signature.slice(2), "hex")),
            ).toBe(true)
        })
    }

    it("commitments hash", () => {
        expect(
            fieldToHex(commitmentsHash(vectors.transfers.map(t => BigInt(t.commitment)))),
        ).toBe(vectors.commitmentsHash)
    })
})

describe("encoding rules", () => {
    it("splits an account into two 128-bit limbs", () => {
        const [hi, lo] = accountLimbs("0x" + "ff".repeat(16) + "00".repeat(15) + "01")
        expect(hi).toBe((1n << 128n) - 1n)
        expect(lo).toBe(1n)
        expect(() => accountLimbs("0x" + "AA".repeat(32))).toThrow()
        expect(() => accountLimbs("0x1234")).toThrow()
    })

    it("refuses deltas at or beyond 2^128 and non-canonical strings", () => {
        expect(parseDelta("-11")).toBe(-11n)
        expect(() => parseDelta((1n << 128n).toString())).toThrow()
        expect(() => parseDelta("-" + (1n << 128n).toString())).toThrow()
        for (const bad of ["-0", "01", "+1", "1e3", "", " 1"]) {
            expect(() => parseDelta(bad)).toThrow()
        }
    })

    it("refuses out-of-range openings", () => {
        const base = { from: A, to: B, amount: 1n, fee: 1n, nonce: 1n, salt: 1n }
        expect(() => settlementCommitment({ ...base, amount: 1n << 128n })).toThrow()
        expect(() => settlementCommitment({ ...base, amount: -1n })).toThrow()
        expect(() => settlementCommitment({ ...base, nonce: 1n << 64n })).toThrow()
        expect(() => settlementCommitment({ ...base, salt: 1n << 248n })).toThrow()
    })

    it("lays out public signals with active slots first and zero padding", () => {
        const c = settlementCommitment({ from: A, to: B, amount: 10n, fee: 1n, nonce: 3n, salt: 9n })
        const s = settlementPublicSignals(
            [{ commitment: c, signer: A, nonce: 3n, fee: 1n }],
            [
                { account: A, balanceBefore: 100n, delta: -11n },
                { account: B, balanceBefore: 0n, delta: 10n },
            ],
        )
        expect(s).toHaveLength(SETTLEMENT_PUBLIC_SIGNALS)
        expect(s[0]).toBe(commitmentsHash([c]))
        expect(s.slice(1, 11)).toEqual([1n, ...Array(9).fill(0n)])
        // deltaNegative and deltaMagnitude are the last 2 * 20 signals
        expect(s.slice(131, 133)).toEqual([1n, 0n])
        expect(s.slice(151, 153)).toEqual([11n, 10n])
    })

    it("refuses unsorted or repeated accounts", () => {
        const t = [{ commitment: 1n, signer: A, nonce: 1n, fee: 0n }]
        expect(() =>
            settlementPublicSignals(t, [
                { account: B, balanceBefore: 0n, delta: 0n },
                { account: A, balanceBefore: 0n, delta: 0n },
            ]),
        ).toThrow()
        expect(() =>
            settlementPublicSignals(t, [
                { account: A, balanceBefore: 0n, delta: 0n },
                { account: A, balanceBefore: 0n, delta: 0n },
            ]),
        ).toThrow()
    })
})
