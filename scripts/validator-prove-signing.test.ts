import { beforeAll, describe, expect, it } from "bun:test"
import { getUnifiedCryptoInstance, uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import {
    type SigningProof,
    buildChallenge,
    parseChallenge,
    verifyProofs,
} from "./validator-prove-signing"

const GENESIS = "ab".repeat(32)
const DATE = "2026-11-08"

interface Key {
    identity: string
    sign: (message: string) => Promise<string>
}

async function makeKey(label: string, seedByte: number): Promise<Key> {
    const seed = new Uint8Array(128).fill(seedByte)
    const crypto = getUnifiedCryptoInstance(label, seed)
    await crypto.generateIdentity("ed25519", seed)
    const { publicKey } = await crypto.getIdentity("ed25519")
    return {
        identity: uint8ArrayToHex(publicKey as Uint8Array),
        sign: async message => {
            const signed = await crypto.sign("ed25519", new TextEncoder().encode(message))
            return uint8ArrayToHex(signed.signature as Uint8Array)
        },
    }
}

async function proofBy(key: Key, challenge = buildChallenge(GENESIS, DATE)): Promise<SigningProof> {
    return { identity: key.identity, algorithm: "ed25519", challenge, signature: await key.sign(challenge) }
}

let keys: Key[] = []
let validators: string[] = []

beforeAll(async () => {
    keys = await Promise.all([1, 2, 3, 4].map(i => makeKey(`prove-signing-${i}`, i)))
    validators = keys.slice(0, 3).map(k => k.identity)
})

describe("challenge format", () => {
    it("round-trips and lowercases the genesis hash", () => {
        const c = buildChallenge("0x" + "AB".repeat(32), DATE)
        expect(c).toBe(`demos-launch-proof:0x${"ab".repeat(32)}:${DATE}`)
        expect(parseChallenge(c)).toEqual({ genesisHash: "0x" + "ab".repeat(32), date: DATE })
    })

    it("refuses anything that is not a genesis hash and a date", () => {
        expect(() => buildChallenge("not-a-hash", DATE)).toThrow()
        expect(() => buildChallenge(GENESIS, "8 Nov")).toThrow()
        // A bare block hash, what a block signature covers, is never a challenge
        expect(parseChallenge(GENESIS)).toBeNull()
        expect(parseChallenge(`other-prefix:${GENESIS}:${DATE}`)).toBeNull()
    })
})

describe("verifyProofs with real ed25519 signatures", () => {
    it("accepts a proof from every genesis validator", async () => {
        const proofs = await Promise.all(keys.slice(0, 3).map(k => proofBy(k)))
        const r = await verifyProofs(proofs, validators, { genesisHash: GENESIS, date: DATE, requireAll: true })
        expect(r.ok).toBe(true)
        expect(r.missing).toEqual([])
        expect(r.genesisHash).toBe(GENESIS)
    })

    it("reports missing validators, and fails on them only with requireAll", async () => {
        const proofs = [await proofBy(keys[0])]
        expect((await verifyProofs(proofs, validators)).ok).toBe(true)
        const strict = await verifyProofs(proofs, validators, { requireAll: true })
        expect(strict.ok).toBe(false)
        expect(strict.missing).toEqual([keys[1].identity, keys[2].identity])
    })

    it("rejects a signature by another key under a validator's identity", async () => {
        const forged = { ...(await proofBy(keys[3])), identity: keys[0].identity }
        const r = await verifyProofs([forged], validators)
        expect(r.ok).toBe(false)
        expect(r.reports[0].reason).toContain("does not verify")
    })

    it("rejects a signature with a flipped byte", async () => {
        const proof = await proofBy(keys[0])
        proof.signature = proof.signature.slice(0, -2) + (proof.signature.endsWith("00") ? "01" : "00")
        expect((await verifyProofs([proof], validators)).ok).toBe(false)
    })

    it("rejects a signature over another challenge", async () => {
        const other = buildChallenge(GENESIS, "2026-11-07")
        const proof = { ...(await proofBy(keys[0], other)), challenge: buildChallenge(GENESIS, DATE) }
        expect((await verifyProofs([proof], validators)).reports[0].reason).toContain("does not verify")
    })

    it("rejects a key outside the genesis validator list", async () => {
        const r = await verifyProofs([await proofBy(keys[3])], validators)
        expect(r.ok).toBe(false)
        expect(r.reports[0].reason).toBe("not a genesis validator")
    })

    it("rejects another genesis or another date", async () => {
        const otherGenesis = await proofBy(keys[0], buildChallenge("cd".repeat(32), DATE))
        const r1 = await verifyProofs([otherGenesis], validators, { genesisHash: GENESIS })
        expect(r1.reports[0].reason).toContain("expected " + GENESIS)

        const otherDate = await proofBy(keys[0], buildChallenge(GENESIS, "2026-11-01"))
        const r2 = await verifyProofs([otherDate], validators, { date: DATE })
        expect(r2.reports[0].reason).toContain("expected " + DATE)
    })

    it("needs every proof on one genesis when none is given", async () => {
        const a = await proofBy(keys[0])
        const b = await proofBy(keys[1], buildChallenge("cd".repeat(32), DATE))
        const r = await verifyProofs([a, b], validators)
        expect(r.ok).toBe(false)
        expect(r.reports.map(x => x.ok)).toEqual([true, false])
    })

    it("rejects a signed bare challenge that lacks the prefix", async () => {
        const proof = { identity: keys[0].identity, challenge: GENESIS, signature: await keys[0].sign(GENESIS) }
        expect((await verifyProofs([proof], validators)).reports[0].reason).toContain("challenge is not")
    })

    it("rejects malformed and duplicate proofs and other algorithms", async () => {
        const good = await proofBy(keys[0])
        const r = await verifyProofs(
            [good, good, { ...good, algorithm: "falcon" }, { identity: keys[1].identity } as SigningProof],
            validators,
        )
        expect(r.reports.map(x => x.reason)).toEqual([
            null,
            "duplicate proof for this identity",
            "algorithm falcon; block signatures are ed25519",
            "malformed proof: identity, challenge and signature are required",
        ])
        expect(r.ok).toBe(false)
    })

    it("is not ok with no proofs at all", async () => {
        expect((await verifyProofs([], validators)).ok).toBe(false)
    })
})
