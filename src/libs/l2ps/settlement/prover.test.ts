/**
 * Settlement proof verification against the committed key, with a committed
 * proof (__fixtures__/settlementProof.json), so it runs without the proving
 * key. Every public signal is part of the statement (through the public hash
 * of Interface v1.1): changing any one of them must make the proof fail.
 */
import { describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { getCurveFromName } from "ffjavascript"
import { fixtureBatch } from "./__fixtures__/batches"
import fixture from "./__fixtures__/settlementProof.json"
import { buildSettlementCircuitInput } from "./circuitInput"
import {
    commitmentsHash,
    SETTLEMENT_ACCOUNTS as M,
    SETTLEMENT_PUBLIC_SIGNALS,
    SETTLEMENT_TRANSFERS as N,
    settlementPublicSignals,
} from "./encoding"
import { planSettlement } from "./planner"
import {
    BASE_FIELD_ORDER,
    FIELD_ORDER,
    loadSettlementVerificationKey,
    publicSignalsProblem,
    SettlementVerifierFault,
    SETTLEMENT_VKEY_DIGEST,
    settlementProofProblem,
    verifySettlementProof,
    vkeyDigest,
} from "./prover"
import { settlementFiles } from "../zk/settlementArtifacts"
import { plonkVerifyBun, plonkVerifyBunStrict } from "../zk/BunPlonkWrapper"

const signals = () => fixture.publicSignals.map(BigInt)

// Offsets of the Interface v1 signal groups.
const AT = {
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
    last: SETTLEMENT_PUBLIC_SIGNALS - 1,
}
const proof = () => structuredClone(fixture.proof) as Record<string, unknown>

function plan() {
    const { transfers, balances, nonces } = fixtureBatch()
    return planSettlement(transfers, balances, nonces)
}

/** Public signals of the fixture batch with some public part changed. */
function rebuilt(edit: (p: ReturnType<typeof plan>) => void, hashOrder?: number[]): bigint[] {
    const p = plan()
    edit(p)
    const s = settlementPublicSignals(
        p.transfers.map(t => ({ commitment: t.commitment, signer: t.from, nonce: t.nonce, fee: t.fee })),
        p.changes.map(c => ({ account: c.account, balanceBefore: p.balancesBefore.get(c.account) as bigint, delta: c.delta })),
    )
    if (hashOrder) s[0] = commitmentsHash(hashOrder.map(i => p.transfers[i].commitment))
    return s
}

describe("settlement verification key", () => {
    it("is the committed one, and the fixture proof was made with it", () => {
        const text = fs.readFileSync(settlementFiles().vkey, "utf8")
        expect(vkeyDigest(text)).toBe(SETTLEMENT_VKEY_DIGEST)
        expect(fixture.vkeyDigest).toBe(SETTLEMENT_VKEY_DIGEST)
        // Interface v1.1: the hash of the statement is the one public input.
        expect((loadSettlementVerificationKey() as { nPublic: number }).nPublic).toBe(1)
    })

    it("refuses a modified key instead of verifying with it", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "settlement-vkey-"))
        try {
            const file = path.join(dir, "verification_key.json")
            const vkey = JSON.parse(fs.readFileSync(settlementFiles().vkey, "utf8"))
            vkey.k1 = "5"
            fs.writeFileSync(file, JSON.stringify(vkey))
            expect(() => loadSettlementVerificationKey(file)).toThrow(/not the one committed/)
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it("accepts the same key in another layout", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "settlement-vkey-"))
        try {
            const file = path.join(dir, "verification_key.json")
            fs.writeFileSync(file, JSON.stringify(JSON.parse(fs.readFileSync(settlementFiles().vkey, "utf8"))))
            expect(() => loadSettlementVerificationKey(file)).not.toThrow()
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })
})

describe("field orders", () => {
    it("are bn128's", async () => {
        const curve = await getCurveFromName("bn128", true)
        try {
            expect(FIELD_ORDER).toBe(curve.r)
            expect(BASE_FIELD_ORDER).toBe(curve.q)
        } finally {
            await curve.terminate()
        }
    })
})

describe("verifySettlementProof", () => {
    it("accepts the fixture proof, whose signals are the validators' rebuild of the batch", async () => {
        expect(signals()).toEqual(buildSettlementCircuitInput(plan()).publicSignals)
        expect(await verifySettlementProof(signals(), proof())).toBe(true)
    })

    it("verifies in tens of milliseconds once warm", async () => {
        await verifySettlementProof(signals(), proof())
        const times: number[] = []
        for (let i = 0; i < 20; i++) {
            const t = performance.now()
            expect(await verifySettlementProof(signals(), proof())).toBe(true)
            times.push(performance.now() - t)
        }
        times.sort((x, y) => x - y)
        const median = times[10]
        console.log(`settlement verify: median ${median.toFixed(1)} ms, max ${times[19].toFixed(1)} ms`)
        // The target is 50 ms; the bound leaves room for a loaded test host.
        expect(median).toBeLessThan(250)
    })

    it("gives every concurrent caller its own verdict", async () => {
        const bad = signals()
        bad[0] += 1n
        const verdicts = await Promise.all([
            verifySettlementProof(signals(), proof()),
            verifySettlementProof(bad, proof()),
            verifySettlementProof(signals(), proof()),
            verifySettlementProof(bad, proof()),
        ])
        expect(verdicts).toEqual([true, false, true, false])
    })

    it("rejects the proof when any single public signal changes", async () => {
        const accepted: number[] = []
        for (let i = 0; i < SETTLEMENT_PUBLIC_SIGNALS; i++) {
            const s = signals()
            // Flags flip within their range so the range check is not what rejects.
            s[i] = s[i] === 0n ? 1n : s[i] - 1n
            if (await verifySettlementProof(s, proof())) accepted.push(i)
        }
        expect(accepted).toEqual([])
    })

    it("rejects a changed public balance", async () => {
        const s = rebuilt(p => p.balancesBefore.set(p.changes[1].account, 1n))
        expect(publicSignalsProblem(s)).toBeUndefined()
        expect(await verifySettlementProof(s, proof())).toBe(false)
    })

    it("rejects a changed delta", async () => {
        const s = rebuilt(p => (p.changes[2].delta += 1n))
        expect(await verifySettlementProof(s, proof())).toBe(false)
    })

    it("rejects the commitments in another order", async () => {
        const s = rebuilt(() => undefined, [1, 0, 2])
        expect(await verifySettlementProof(s, proof())).toBe(false)
        expect(await verifySettlementProof(rebuilt(() => undefined, [0, 1, 2]), proof())).toBe(true)
    })

    it("rejects another nonce or fee", async () => {
        expect(await verifySettlementProof(rebuilt(p => (p.transfers[0] = { ...p.transfers[0], nonce: 2n })), proof())).toBe(false)
        expect(await verifySettlementProof(rebuilt(p => (p.transfers[1] = { ...p.transfers[1], fee: 11n })), proof())).toBe(false)
    })

    it("rejects any signal at or above the field order, which would alias a valid one", async () => {
        for (const i of [0, AT.transferActive, AT.nonce, AT.accountActive + 3, AT.balanceBefore, AT.last]) {
            const s = signals()
            s[i] += FIELD_ORDER
            expect(publicSignalsProblem(s)).toMatch(/out of range/)
            expect(await verifySettlementProof(s, proof())).toBe(false)
        }
        const s = signals()
        s[0] = FIELD_ORDER
        expect(await verifySettlementProof(s, proof())).toBe(false)
    })

    it("rejects values outside each signal's own range", () => {
        const at = (i: number, v: bigint) => {
            const s = signals()
            s[i] = v
            return publicSignalsProblem(s)
        }
        expect(at(AT.transferActive, 2n)).toMatch(/out of range/)
        expect(at(AT.fee, 1n << 128n)).toMatch(/out of range/)
        expect(at(AT.accountActive, 2n)).toMatch(/out of range/)
        expect(at(AT.accountHi, 1n << 128n)).toMatch(/out of range/)
        expect(at(AT.nonce, 1n << 64n)).toMatch(/out of range/)
        expect(at(AT.nonce, (1n << 64n) - 1n)).toBeUndefined()
        expect(at(AT.balanceBefore, 1n << 128n)).toMatch(/out of range/)
        expect(at(AT.deltaNegative, 2n)).toMatch(/out of range/)
        expect(at(AT.deltaMagnitude, -1n)).toMatch(/out of range/)
    })

    it("rejects, without throwing, a signer that is not an account of the batch", async () => {
        const s = signals()
        s[AT.signerHi] = 0x99n
        expect(publicSignalsProblem(s)).toBeUndefined()
        expect(await verifySettlementProof(s, proof())).toBe(false)
        const idle = signals()
        idle[AT.signerLo + N - 1] = 1n
        expect(await verifySettlementProof(idle, proof())).toBe(false)
    })

    it("rejects signers swapped between two transfers", async () => {
        const s = signals()
        ;[s[AT.signerHi], s[AT.signerHi + 1]] = [s[AT.signerHi + 1], s[AT.signerHi]]
        ;[s[AT.signerLo], s[AT.signerLo + 1]] = [s[AT.signerLo + 1], s[AT.signerLo]]
        expect(await verifySettlementProof(s, proof())).toBe(false)
    })

    it("rejects malformed signal lists", async () => {
        for (const s of [signals().slice(1), [...signals(), 0n], signals().map(String), null, {}]) {
            expect(await verifySettlementProof(s as unknown as bigint[], proof())).toBe(false)
        }
    })

    it("rejects malformed proofs before any library parses them", async () => {
        const cases: [string, (p: Record<string, unknown>) => unknown][] = [
            ["not an object", () => null],
            ["an array", () => []],
            ["unknown field", p => ({ ...p, extra: "1" })],
            ["groth16", p => ({ ...p, protocol: "groth16" })],
            ["another curve", p => ({ ...p, curve: "bls12381" })],
            ["missing point", p => ({ ...p, A: undefined })],
            ["leading zero", p => ({ ...p, eval_a: "0" + p.eval_a })],
            ["hex scalar", p => ({ ...p, eval_a: "0x1" })],
            ["scalar at the field order", p => ({ ...p, eval_a: FIELD_ORDER.toString() })],
            ["coordinate at the base field order", p => ({ ...p, A: [BASE_FIELD_ORDER.toString(), "1", "1"] })],
            ["number instead of string", p => ({ ...p, eval_b: 1 })],
            ["point of the wrong size", p => ({ ...p, Z: ["1"] })],
            ["affine point without z", p => ({ ...p, A: (p.A as string[]).slice(0, 2) })],
            ["z other than 1", p => ({ ...p, A: [...(p.A as string[]).slice(0, 2), "2"] })],
            ["infinity written another way", p => ({ ...p, A: ["0", "2", "0"] })],
            ["Jacobian re-encoding of A", p => ({ ...p, A: jacobian(p.A as string[], 2n) })],
        ]
        for (const [name, make] of cases) {
            const bad = make(proof())
            expect({ name, problem: settlementProofProblem(bad) !== undefined }).toEqual({ name, problem: true })
            expect(await verifySettlementProof(signals(), bad as Record<string, unknown>)).toBe(false)
        }
    })

    it("rejects well-formed proofs that are wrong", async () => {
        const p = proof()
        const swapped = { ...p, eval_a: p.eval_b, eval_b: p.eval_a }
        expect(await verifySettlementProof(signals(), swapped)).toBe(false)
        const offCurve = { ...p, A: ["1", "1", "1"] }
        expect(settlementProofProblem(offCurve)).toMatch(/not on the curve/)
        expect(await verifySettlementProof(signals(), offCurve)).toBe(false)
        const moved = { ...p, Wxi: p.Wxiw, Wxiw: p.Wxi }
        expect(await verifySettlementProof(signals(), moved)).toBe(false)
    })
})

/** The same point in Jacobian coordinates with the given z: (x z^2, y z^3, z). */
function jacobian(point: string[], z: bigint): string[] {
    const q = BASE_FIELD_ORDER
    const [x, y] = point.map(BigInt)
    return [((x * z ** 2n) % q).toString(), ((y * z ** 3n) % q).toString(), z.toString()]
}

describe("proof encoding is canonical", () => {
    it("the fixture writes every point as [x, y, \"1\"]", () => {
        for (const key of ["A", "B", "C", "Z", "T1", "T2", "T3", "Wxi", "Wxiw"]) {
            expect((fixture.proof as unknown as Record<string, string[]>)[key][2]).toBe("1")
        }
    })

    it("a Jacobian re-encoding of a valid proof is refused, though the pairing would accept it", async () => {
        const p = proof()
        const reencoded = { ...p, A: jacobian(p.A as string[], 2n) }
        const vkey = loadSettlementVerificationKey()
        const hash = buildSettlementCircuitInput(plan()).publicHash.toString()
        // The math alone would accept it: only the encoding rule refuses it.
        expect(await plonkVerifyBun(vkey, [hash], reencoded)).toBe(true)
        expect(settlementProofProblem(reencoded)).toMatch(/A/)
        expect(await verifySettlementProof(signals(), reencoded)).toBe(false)
    })

    it("a point at infinity is well-formed and the proof fails, without a fault", async () => {
        for (const key of ["A", "B", "C", "Z", "T1", "T2", "T3", "Wxi", "Wxiw"]) {
            const bad = { ...proof(), [key]: ["0", "1", "0"] }
            expect(settlementProofProblem(bad)).toBeUndefined()
            expect(await verifySettlementProof(signals(), bad)).toBe(false)
        }
    })
})

describe("verifier faults are not verdicts", () => {
    // false: the proof is invalid on every honest node. A throw
    // (SettlementVerifierFault): this node cannot judge it.
    it("a missing verification key throws a fault", async () => {
        const missing = path.join(os.tmpdir(), "no-such-dir", "verification_key.json")
        await expect(verifySettlementProof(signals(), proof(), { vkeyFile: missing })).rejects.toBeInstanceOf(
            SettlementVerifierFault,
        )
    })

    it("a modified verification key throws a fault, even for a malformed proof", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "settlement-vkey-"))
        try {
            const file = path.join(dir, "verification_key.json")
            const vkey = JSON.parse(fs.readFileSync(settlementFiles().vkey, "utf8"))
            vkey.k1 = "5"
            fs.writeFileSync(file, JSON.stringify(vkey))
            await expect(verifySettlementProof(signals(), proof(), { vkeyFile: file })).rejects.toBeInstanceOf(
                SettlementVerifierFault,
            )
            await expect(verifySettlementProof(signals(), {}, { vkeyFile: file })).rejects.toBeInstanceOf(
                SettlementVerifierFault,
            )
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it("a curve that cannot be built throws a fault", async () => {
        const curve = () => Promise.reject(new Error("out of memory"))
        await expect(verifySettlementProof(signals(), proof(), { curve })).rejects.toBeInstanceOf(
            SettlementVerifierFault,
        )
    })

    it("an internal error in the verifier throws a fault", async () => {
        const curve = () => Promise.resolve({})
        await expect(verifySettlementProof(signals(), proof(), { curve })).rejects.toBeInstanceOf(
            SettlementVerifierFault,
        )
    })

    it("a fault does not change the next caller's verdict", async () => {
        const curve = () => Promise.resolve({})
        const faulted = verifySettlementProof(signals(), proof(), { curve })
        const next = verifySettlementProof(signals(), proof())
        await expect(faulted).rejects.toBeInstanceOf(SettlementVerifierFault)
        expect(await next).toBe(true)
    })

    it("the strict PLONK verifier throws where the lenient one returns false", async () => {
        const vkey = loadSettlementVerificationKey()
        const hash = buildSettlementCircuitInput(plan()).publicHash.toString()
        expect(await plonkVerifyBun(vkey, [hash], proof(), undefined, {})).toBe(false)
        await expect(plonkVerifyBunStrict(vkey, [hash], proof(), {})).rejects.toThrow()
    })
})
