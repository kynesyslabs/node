/**
 * Block apply lets a throw from verifySettlementProof escape (the node sits
 * the round out), so no input a transaction controls may make it throw: one
 * such batch would halt every node. For any proof JSON and any public signal
 * array it must return false, and only a local fault (key, curve, verifier)
 * may throw. Table-driven cases plus a seeded fuzz over the fixture proof.
 */
import { describe, expect, it } from "bun:test"
import fixture from "./__fixtures__/settlementProof.json"
import { FIELD_ORDER, SETTLEMENT_PUBLIC_SIGNALS } from "./encoding"
import { BASE_FIELD_ORDER, verifySettlementProof } from "./prover"

const Q = BASE_FIELD_ORDER
const R = FIELD_ORDER
const POINT_KEYS = ["A", "B", "C", "Z", "T1", "T2", "T3", "Wxi", "Wxiw"]
const SCALAR_KEYS = ["eval_a", "eval_b", "eval_c", "eval_s1", "eval_s2", "eval_zw"]
const ALL_KEYS = [...POINT_KEYS, ...SCALAR_KEYS, "protocol", "curve"]

const signals = (): bigint[] => fixture.publicSignals.map(BigInt)
const proof = (): Record<string, any> => structuredClone(fixture.proof)

/** Deterministic PRNG (mulberry32) so a failure reproduces from its case number. */
function rng(seed: number) {
    let a = seed >>> 0
    const next = (): number => {
        a = (a + 0x6d2b79f5) >>> 0
        let t = a
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const int = (n: number): number => Math.floor(next() * n)
    const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)]
    const bigBelow = (limit: bigint): bigint => {
        let x = 0n
        for (let i = 0; i < 9; i++) x = (x << 32n) | BigInt(int(2 ** 32))
        return x % limit
    }
    return { next, int, pick, bigBelow }
}
type Rng = ReturnType<typeof rng>

/** Any JSON-ish value a transaction could carry, biased towards near misses. */
function junk(r: Rng, depth = 0): unknown {
    const kinds = [
        () => null,
        () => r.next() < 0.5,
        () => r.pick([0, 1, -1, 2, 1e308, -1e308, 0.5, Number.MAX_SAFE_INTEGER + 2, -0]),
        () => r.pick(["", " 1", "1 ", "-1", "+1", "01", "0x1", "1e3", "1.0", "NaN", "Infinity", "٣", "\u0000"]),
        () => r.pick([Q, Q - 1n, Q + 1n, R, R - 1n, R + 1n, 2n ** 256n, 10n ** 78n, 10n ** 77n]).toString(),
        () => r.bigBelow(Q).toString(),
        () => "9".repeat(r.pick([79, 200, 100_000])),
        () => "-" + r.bigBelow(R).toString(),
        () => (depth < 3 ? Array.from({ length: r.int(5) }, () => junk(r, depth + 1)) : []),
        () => (depth < 3 ? Object.fromEntries([["x", junk(r, depth + 1)], [r.pick(ALL_KEYS), junk(r, depth + 1)]]) : {}),
    ]
    return r.pick(kinds)()
}

/** Valid affine points the fixture does not use where they are put. */
function onCurvePoint(r: Rng): string[] {
    const [x, y] = (fixture.proof as Record<string, any>)[r.pick(POINT_KEYS)].map(BigInt)
    return r.next() < 0.5 ? [x.toString(), ((Q - y) % Q).toString(), "1"] : [x.toString(), y.toString(), "1"]
}

function mutateProof(r: Rng): unknown {
    const p = proof()
    const kind = r.int(12)
    switch (kind) {
        case 0:
            return junk(r)
        case 1:
            p[r.pick(ALL_KEYS)] = junk(r)
            return p
        case 2:
            delete p[r.pick(ALL_KEYS)]
            return p
        case 3:
            p[r.pick(["extra", "__proto__", "constructor", "Z2", "eval_r"])] = junk(r)
            return p
        case 4: {
            const key = r.pick(POINT_KEYS)
            p[key] = Array.from({ length: r.pick([0, 1, 2, 4, 5]) }, () => r.bigBelow(Q).toString())
            return p
        }
        case 5: {
            const key = r.pick(POINT_KEYS)
            p[key] = [...p[key]]
            p[key][r.int(3)] = junk(r)
            return p
        }
        case 6: {
            const key = r.pick(POINT_KEYS)
            p[key] = r.pick([
                [r.bigBelow(Q).toString(), r.bigBelow(Q).toString(), "1"],
                [p[key][0], p[key][1], r.pick(["0", "2", (Q - 1n).toString()])],
                [r.pick(["0", "1"]), r.pick(["0", "1", "2"]), r.pick(["0", "1"])],
                [(BigInt(p[key][0]) + Q).toString(), p[key][1], "1"],
            ])
            return p
        }
        case 7: {
            // Well-formed and on the curve: reaches the PLONK library.
            p[r.pick(POINT_KEYS)] = r.next() < 0.3 ? ["0", "1", "0"] : onCurvePoint(r)
            return p
        }
        case 8: {
            // Canonical scalars: reaches the PLONK library.
            p[r.pick(SCALAR_KEYS)] = r.pick(["0", "1", (R - 1n).toString(), r.bigBelow(R).toString()])
            return p
        }
        case 9:
            p[r.pick(SCALAR_KEYS)] = r.pick([R.toString(), (R + 1n).toString(), Q.toString(), "-1", "00", 5, null, ["1"]])
            return p
        case 10:
            p[r.pick(["protocol", "curve"])] = r.pick(["groth16", "fflonk", "bls12381", "PLONK", "", 1, null])
            return p
        default: {
            // Several faults at once.
            for (let i = 0; i < 3; i++) p[r.pick(ALL_KEYS)] = r.next() < 0.5 ? junk(r) : onCurvePoint(r)
            return p
        }
    }
}

function mutateSignals(r: Rng): unknown {
    const s: unknown[] = signals()
    const kind = r.int(8)
    switch (kind) {
        case 0:
            return junk(r)
        case 1:
            return r.next() < 0.5 ? s.slice(0, r.int(SETTLEMENT_PUBLIC_SIGNALS)) : [...s, ...Array(1 + r.int(5)).fill(0n)]
        case 2:
            s[r.int(s.length)] = junk(r)
            return s
        case 3:
            s[r.int(s.length)] = r.pick([-1n, -(2n ** 200n), 2n ** 64n, 2n ** 128n, R, R + 1n, Q, 2n ** 256n])
            return s
        case 4:
            s[r.int(s.length)] = r.pick([undefined, 1, "1", 1.5, NaN, {}, [], Symbol.for("x")])
            return s
        case 5:
            return new Array(SETTLEMENT_PUBLIC_SIGNALS)
        case 6: {
            // In range for some slots, out for others; reaches the hash and
            // possibly the PLONK library.
            s[r.int(s.length)] = r.pick([0n, 1n, 2n, r.bigBelow(2n ** 64n), r.bigBelow(2n ** 128n)])
            return s
        }
        default:
            return s.map(v => (r.next() < 0.1 ? (v as bigint) + 1n : v))
    }
}

async function mustNotThrow(publicSignals: unknown, p: unknown, label: string): Promise<void> {
    let verdict: unknown
    try {
        verdict = await verifySettlementProof(publicSignals as bigint[], p as Record<string, unknown>)
    } catch (error) {
        throw new Error(`${label}: threw ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
    }
    // A mutation can land on the value already there (or only swap the
    // prototype through "__proto__"); the same data must still verify, and
    // anything else must be refused.
    const unchanged = Bun.deepEquals(publicSignals, signals(), true) && JSON.stringify(p) === JSON.stringify(fixture.proof)
    expect({ label, verdict }).toEqual({ label, verdict: unchanged })
}

describe("verifySettlementProof on attacker-controlled input", () => {
    it("still accepts the valid fixture", async () => {
        expect(await verifySettlementProof(signals(), proof())).toBe(true)
    })

    it("returns false without throwing on hand-picked malformed proofs", async () => {
        const p = proof()
        const cases: [string, unknown][] = [
            ["null", null],
            ["undefined", undefined],
            ["number", 1],
            ["string", "proof"],
            ["array", [p]],
            ["empty object", {}],
            ["missing A", { ...p, A: undefined }],
            ["A as string", { ...p, A: "1,2,1" }],
            ["A nested", { ...p, A: [[p.A[0]], [p.A[1]], ["1"]] }],
            ["A numbers", { ...p, A: [1, 2, 1] }],
            ["A huge string", { ...p, A: ["9".repeat(1_000_000), "1", "1"] }],
            ["A hex", { ...p, A: ["0x" + BigInt(p.A[0]).toString(16), p.A[1], "1"] }],
            ["A negative", { ...p, A: ["-" + p.A[0], p.A[1], "1"] }],
            ["A x + q", { ...p, A: [(BigInt(p.A[0]) + Q).toString(), p.A[1], "1"] }],
            ["A x = q", { ...p, A: [Q.toString(), p.A[1], "1"] }],
            ["A off the curve", { ...p, A: [p.A[0], (BigInt(p.A[1]) + 1n).toString(), "1"] }],
            ["A z = 0 not infinity", { ...p, A: [p.A[0], p.A[1], "0"] }],
            ["A infinity", { ...p, A: ["0", "1", "0"] }],
            ["A four coordinates", { ...p, A: [...p.A, "1"] }],
            ["eval_a = r", { ...p, eval_a: R.toString() }],
            ["eval_a negative", { ...p, eval_a: "-1" }],
            ["eval_a number", { ...p, eval_a: 1 }],
            ["eval_a zero", { ...p, eval_a: "0" }],
            ["extra field", { ...p, extra: 1 }],
            ["__proto__ field", JSON.parse(JSON.stringify(p).replace(/^\{/, '{"__proto__":{"A":1},'))],
            ["wrong protocol", { ...p, protocol: "groth16" }],
            ["every point at infinity", Object.fromEntries(Object.entries(p).map(([k, v]) => [k, POINT_KEYS.includes(k) ? ["0", "1", "0"] : v]))],
        ]
        for (const [label, bad] of cases) await mustNotThrow(signals(), bad, label)
    })

    it("returns false without throwing on hand-picked malformed signals", async () => {
        const s = signals()
        const cases: [string, unknown][] = [
            ["null", null],
            ["object", { length: SETTLEMENT_PUBLIC_SIGNALS }],
            ["strings", s.map(String)],
            ["numbers", s.map(Number)],
            ["empty", []],
            ["one short", s.slice(1)],
            ["one long", [...s, 0n]],
            ["sparse", new Array(SETTLEMENT_PUBLIC_SIGNALS)],
            ["negative", [-1n, ...s.slice(1)]],
            ["hash = r", [R, ...s.slice(1)]],
            ["limb = 2^128", s.map((v, i) => (i === s.length - 1 ? 2n ** 128n : v))],
            ["all zero", Array(SETTLEMENT_PUBLIC_SIGNALS).fill(0n)],
            ["all one", Array(SETTLEMENT_PUBLIC_SIGNALS).fill(1n)],
        ]
        for (const [label, bad] of cases) await mustNotThrow(bad, proof(), label)
    })

    it("returns false without throwing on 3,000 seeded random inputs", async () => {
        const r = rng(0x5e771e)
        for (let i = 0; i < 2_000; i++) await mustNotThrow(signals(), mutateProof(r), `proof case ${i}`)
        for (let i = 0; i < 1_000; i++) await mustNotThrow(mutateSignals(r), proof(), `signals case ${i}`)
    }, 300_000)
})
