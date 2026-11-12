import { describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import vectors from "./__fixtures__/settlementVectors.json"
import {
    accountLimbs,
    commitmentsHash,
    FIELD_ORDER,
    fieldToHex,
    parseDelta,
    settlementCommitment,
    settlementPublicHash,
    settlementPublicSignals,
    settlementSignatureMessage,
    SETTLEMENT_ACCOUNTS as M,
    SETTLEMENT_PUBLIC_SIGNALS,
    SETTLEMENT_TRANSFERS as N,
    SettlementEncodingError,
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
        expect(s.slice(1, 1 + N)).toEqual([1n, ...Array(N - 1).fill(0n)])
        // deltaNegative and deltaMagnitude are the last 2 * M signals
        const negative = 1 + 5 * N + 4 * M
        expect(s.slice(negative, negative + 2)).toEqual([1n, 0n])
        expect(s.slice(negative + M, negative + M + 2)).toEqual([11n, 10n])
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

// The design doc's Interface v1.1 example; changing it is an interface change.
const PINNED_PUBLIC_HASH = "0x06e69393040f0b0be0b77a589cb51dc8d89beb42f28b4a26eec431cb8b544c27"

describe("settlementPublicHash (Interface v1.1)", () => {
    const C = "0x" + "33".repeat(32)
    const statement = () => {
        const c1 = settlementCommitment({ from: A, to: B, amount: 10n, fee: 1n, nonce: 3n, salt: 9n })
        const c2 = settlementCommitment({ from: C, to: A, amount: 4n, fee: 2n, nonce: 7n, salt: 8n })
        return settlementPublicSignals(
            [
                { commitment: c1, signer: A, nonce: 3n, fee: 1n },
                { commitment: c2, signer: C, nonce: 7n, fee: 2n },
            ],
            [
                { account: A, balanceBefore: 100n, delta: -7n },
                { account: B, balanceBefore: 0n, delta: 10n },
                { account: C, balanceBefore: 50n, delta: -6n },
            ],
        )
    }
    // Offsets of the Interface v1 signal groups.
    const at = {
        transferActive: 1,
        signerHi: 1 + N,
        signerLo: 1 + 2 * N,
        nonce: 1 + 3 * N,
        fee: 1 + 4 * N,
        accountActive: 1 + 5 * N,
        accountHi: 1 + 5 * N + M,
        balanceBefore: 1 + 5 * N + 3 * M,
        deltaNegative: 1 + 5 * N + 4 * M,
        deltaMagnitude: 1 + 5 * N + 5 * M,
    }
    const refuses = (s: bigint[], message: RegExp) => {
        expect(() => settlementPublicHash(s)).toThrow(SettlementEncodingError)
        expect(() => settlementPublicHash(s)).toThrow(message)
    }
    const set = (k: number, v: bigint) => {
        const s = statement()
        s[k] = v
        return s
    }

    it("is pinned: other implementations must reproduce this value", () => {
        expect(fieldToHex(settlementPublicHash(statement()))).toBe(PINNED_PUBLIC_HASH)
    })

    it("is a field element", () => {
        const h = settlementPublicHash(statement())
        expect(h > 0n && h < FIELD_ORDER).toBe(true)
    })

    it("changes with every signal, or refuses the changed statement", () => {
        const base = settlementPublicHash(statement())
        const seen = new Set([base])
        let refused = 0
        for (let k = 0; k < SETTLEMENT_PUBLIC_SIGNALS; k++) {
            const s = statement()
            s[k] = s[k] === 0n ? 1n : s[k] === 1n ? 0n : s[k] + 1n
            let h: bigint
            try {
                h = settlementPublicHash(s)
            } catch (error) {
                expect(error).toBeInstanceOf(SettlementEncodingError)
                refused++
                continue
            }
            expect(seen.has(h)).toBe(false)
            seen.add(h)
        }
        // Signer limbs never hash on their own: a changed limb names no
        // account of the batch (active slot) or names a signer (idle slot).
        // Flipping an active flag can strand a signer the same way.
        expect(refused).toBeGreaterThanOrEqual(2 * N)
        expect(seen.size + refused).toBe(SETTLEMENT_PUBLIC_SIGNALS + 1)
    })

    it("binds the signer through its account slot", () => {
        // Swapping the signers of two transfers moves the debit.
        const s = statement()
        ;[s[at.signerHi], s[at.signerHi + 1]] = [s[at.signerHi + 1], s[at.signerHi]]
        ;[s[at.signerLo], s[at.signerLo + 1]] = [s[at.signerLo + 1], s[at.signerLo]]
        expect(settlementPublicHash(s)).not.toBe(settlementPublicHash(statement()))
    })

    it("refuses a signer that is not an account of the batch", () => {
        refuses(set(at.signerHi, 0x99n), /not an account of the batch/)
    })

    it("refuses a signer that matches only an inactive account slot", () => {
        const s = statement()
        s[at.signerHi] = 0n
        s[at.signerLo] = 0n
        refuses(s, /not an account of the batch/)
    })

    it("refuses an idle transfer slot that names a signer", () => {
        refuses(set(at.signerLo + 2, 1n), /idle transfer slot 2 names a signer/)
    })

    it("refuses the wrong number of signals", () => {
        refuses(statement().slice(1), /expected/)
        refuses([...statement(), 0n], /expected/)
    })

    it("refuses values outside their ranges", () => {
        const cases: [number, bigint][] = [
            [0, FIELD_ORDER],
            [0, -1n],
            [at.transferActive, 2n],
            [at.signerHi, 1n << 128n],
            [at.nonce, 1n << 64n],
            [at.fee, 1n << 128n],
            [at.accountActive, 2n],
            [at.accountHi, 1n << 128n],
            [at.balanceBefore, 1n << 128n],
            [at.balanceBefore, FIELD_ORDER - 5n],
            [at.deltaNegative, 2n],
            [at.deltaMagnitude, 1n << 128n],
            [at.deltaMagnitude, FIELD_ORDER - 7n],
        ]
        for (const [k, v] of cases) refuses(set(k, v), new RegExp(`public signal ${k} is out of range`))
    })
})
