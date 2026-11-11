/**
 * Proving runs in the prover subprocess pool only; verification runs in the
 * node, against the committed verification key.
 */
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import { getCurveFromName } from "ffjavascript"
import { Config } from "src/config"
import { plonkVerifyBun } from "../zk/BunPlonkWrapper"
import { settlementFiles } from "../zk/settlementArtifacts"
import { buildSettlementCircuitInput, PUBLIC_INPUT_LAYOUT } from "./circuitInput"
import { AMOUNT_LIMIT, NONCE_LIMIT, SETTLEMENT_PUBLIC_SIGNALS } from "./encoding"
import { SettlementProverPool } from "./proverPool"
import type { SettlementPlan, SettlementProof, SettlementProofResult } from "./types"

export { buildSettlementCircuitInput } from "./circuitInput"

/** BN254 scalar field order: public signals and proof evaluations live below it. */
export const FIELD_ORDER = 21888242871839275222246405745257275088548364400416034343698204186575808495617n
/** BN254 base field order: proof point coordinates live below it. */
export const BASE_FIELD_ORDER = 21888242871839275222246405745257275088696311157297823662689037894645226208583n

/**
 * SHA-256 of the committed settlement verification key over its canonical
 * JSON (keys sorted, layout ignored), the same digest as the setup's
 * canonicalDigest. Every validator must verify with the same key, so a node
 * whose file differs refuses to verify instead of forking off quietly.
 * Changing the circuit means changing this digest in the same commit.
 */
export const SETTLEMENT_VKEY_DIGEST = "e803f4e14ba03c7498a3792efda54c8411cef5cbf929febe479b8305092de8d7"

const sortedDeep = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortedDeep)
    if (value === null || typeof value !== "object") return value
    return Object.fromEntries(
        Object.keys(value as object)
            .sort((a, b) => (a === b ? 0 : a < b ? -1 : 1))
            .map(k => [k, sortedDeep((value as Record<string, unknown>)[k])]),
    )
}

export function vkeyDigest(jsonText: string): string {
    return crypto.createHash("sha256").update(JSON.stringify(sortedDeep(JSON.parse(jsonText)))).digest("hex")
}

const cachedVkeys = new Map<string, unknown>()

/** The committed verification key; throws when it is missing or not the release's. */
export function loadSettlementVerificationKey(file: string = settlementFiles().vkey): unknown {
    const cached = cachedVkeys.get(file)
    if (cached !== undefined) return cached
    const text = fs.readFileSync(file, "utf8")
    const digest = vkeyDigest(text)
    if (digest !== SETTLEMENT_VKEY_DIGEST) {
        throw new Error(`settlement verification key ${file} is not the one committed in this release (digest ${digest})`)
    }
    const vkey = JSON.parse(text)
    if (vkey.nPublic !== SETTLEMENT_PUBLIC_SIGNALS) {
        throw new Error(`settlement verification key has ${vkey.nPublic} public signals, expected ${SETTLEMENT_PUBLIC_SIGNALS}`)
    }
    cachedVkeys.set(file, vkey)
    return vkey
}

const BIT_INPUTS = new Set(["transferActive", "accountActive", "deltaNegative"])

/** Exclusive upper bound of each public signal, in circuit order. */
const SIGNAL_LIMITS: bigint[] = PUBLIC_INPUT_LAYOUT.flatMap(([name, count]) => {
    const limit =
        name === "commitmentsHash" ? FIELD_ORDER
            : BIT_INPUTS.has(name) ? 2n
                : name === "nonce" ? NONCE_LIMIT
                    : AMOUNT_LIMIT
    return Array<bigint>(count).fill(limit)
})

/**
 * Why the public signals are not a statement the circuit can be asked about,
 * or undefined. The circuit range-checks the values its arithmetic uses
 * (fees, balances, magnitudes) but leaves account limbs and nonces to these
 * bounds, and a value at or above the field order would be reduced by the
 * verifier and accepted as a different number.
 */
export function publicSignalsProblem(publicSignals: unknown): string | undefined {
    if (!Array.isArray(publicSignals)) return "public signals are not an array"
    if (publicSignals.length !== SETTLEMENT_PUBLIC_SIGNALS) {
        return `expected ${SETTLEMENT_PUBLIC_SIGNALS} public signals, got ${publicSignals.length}`
    }
    for (let i = 0; i < publicSignals.length; i++) {
        const v = publicSignals[i]
        if (typeof v !== "bigint" || v < 0n || v >= SIGNAL_LIMITS[i]) return `public signal ${i} is out of range`
    }
    return undefined
}

const DECIMAL = /^(0|[1-9][0-9]{0,77})$/
const POINT_KEYS = ["A", "B", "C", "Z", "T1", "T2", "T3", "Wxi", "Wxiw"] as const
const SCALAR_KEYS = ["eval_a", "eval_b", "eval_c", "eval_s1", "eval_s2", "eval_zw"] as const
const PROOF_KEYS = new Set<string>([...POINT_KEYS, ...SCALAR_KEYS, "protocol", "curve"])

const canonicalBelow = (v: unknown, limit: bigint): boolean =>
    typeof v === "string" && DECIMAL.test(v) && BigInt(v) < limit

/**
 * Why a proof JSON is not a well-formed snarkjs PLONK proof, or undefined.
 * The proof comes from a transaction, so its shape is checked before any
 * library parses it: canonical decimals only, scalars below the field order,
 * coordinates below the base field order, no extra fields.
 */
export function settlementProofProblem(proof: unknown): string | undefined {
    if (proof === null || typeof proof !== "object" || Array.isArray(proof)) return "proof is not an object"
    const p = proof as Record<string, unknown>
    for (const key of Object.keys(p)) if (!PROOF_KEYS.has(key)) return `proof has unknown field ${key}`
    if (p.protocol !== "plonk" || p.curve !== "bn128") return "proof is not a bn128 PLONK proof"
    for (const key of POINT_KEYS) {
        const point = p[key]
        if (!Array.isArray(point) || (point.length !== 2 && point.length !== 3)) return `proof ${key} is not a point`
        if (!point.every(c => canonicalBelow(c, BASE_FIELD_ORDER))) return `proof ${key} has a non-canonical coordinate`
    }
    for (const key of SCALAR_KEYS) {
        if (!canonicalBelow(p[key], FIELD_ORDER)) return `proof ${key} is not a canonical scalar`
    }
    return undefined
}

/**
 * True when the proof shows that the public signals (built with
 * settlementPublicSignals from the validator's own state) are the result of
 * the committed transfers. False for any malformed or out-of-range input.
 * Throws only when this node's verification key is missing or modified: that
 * is a broken install, not a bad batch.
 */
export async function verifySettlementProof(
    publicSignals: bigint[],
    proof: SettlementProof,
): Promise<boolean> {
    const vkey = loadSettlementVerificationKey()
    if (publicSignalsProblem(publicSignals) !== undefined) return false
    if (settlementProofProblem(proof) !== undefined) return false
    const run = verifying.then(async () =>
        plonkVerifyBun(vkey, publicSignals.map(String), proof, undefined, await verifierCurve()),
    )
    verifying = run.then(
        () => undefined,
        () => undefined,
    )
    return run
}

// Building the bn128 curve takes longer than a verification, so one curve is
// kept for the life of the process. Verifications share it one at a time:
// they are CPU-bound, so running them in turn costs nothing.
let curvePromise: Promise<unknown> | null = null
let verifying: Promise<void> = Promise.resolve()

function verifierCurve(): Promise<unknown> {
    curvePromise ??= getCurveFromName("bn128", true).catch(error => {
        curvePromise = null
        throw error
    })
    return curvePromise
}

let defaultPool: SettlementProverPool | null = null

/** The node's prover pool, sized by L2PS_SETTLEMENT_PROVERS. */
export function settlementProverPool(): SettlementProverPool {
    defaultPool ??= new SettlementProverPool({ size: Config.getInstance().l2ps.settlementProvers })
    return defaultPool
}

/**
 * Proves a plan in a prover subprocess and checks the proof against the
 * committed key before returning it, so a proof that peers would reject
 * never leaves this node.
 */
export async function proveSettlement(
    plan: SettlementPlan,
    pool: SettlementProverPool = settlementProverPool(),
): Promise<SettlementProofResult> {
    const { input, publicSignals } = buildSettlementCircuitInput(plan)
    const expected = publicSignals.map(String)
    const raw = await pool.prove(input)
    if (
        !Array.isArray(raw.publicSignals) ||
        raw.publicSignals.length !== expected.length ||
        raw.publicSignals.some((s, i) => s !== expected[i])
    ) {
        throw new Error("settlement prover returned public signals that differ from the plan")
    }
    if (!(await verifySettlementProof(publicSignals, raw.proof))) {
        throw new Error("settlement proof does not verify against the committed key")
    }
    return { proof: raw.proof, publicSignals: expected }
}
