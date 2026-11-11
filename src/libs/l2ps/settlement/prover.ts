/**
 * Proving runs in the prover subprocess pool only; verification runs in the
 * node, against the committed verification key.
 */
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import { getCurveFromName } from "ffjavascript"
import { Config } from "src/config"
import { plonkVerifyBunStrict } from "../zk/BunPlonkWrapper"
import { settlementFiles } from "../zk/settlementArtifacts"
import { buildSettlementCircuitInput, PUBLIC_INPUT_LAYOUT } from "./circuitInput"
import {
    AMOUNT_LIMIT,
    FIELD_ORDER,
    NONCE_LIMIT,
    SETTLEMENT_PUBLIC_SIGNALS,
    SettlementEncodingError,
    settlementPublicHash,
} from "./encoding"
import { SettlementProverPool } from "./proverPool"
import type { SettlementPlan, SettlementProof, SettlementProofResult } from "./types"

export { buildSettlementCircuitInput } from "./circuitInput"

export { FIELD_ORDER } from "./encoding"

/**
 * This node cannot judge a settlement proof: its verification key is missing
 * or modified, its curve could not be built, or its verifier failed. Not a
 * verdict on the proof, which may well be valid; a validator must not record
 * the batch as failed because of it.
 */
export class SettlementVerifierFault extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options)
        this.name = "SettlementVerifierFault"
    }
}
/** BN254 base field order: proof point coordinates live below it. */
export const BASE_FIELD_ORDER = 21888242871839275222246405745257275088696311157297823662689037894645226208583n

/**
 * SHA-256 of the committed settlement verification key over its canonical
 * JSON (keys sorted, layout ignored), the same digest as the setup's
 * canonicalDigest. Every validator must verify with the same key, so a node
 * whose file differs refuses to verify instead of forking off quietly.
 * Changing the circuit means changing this digest in the same commit.
 */
export const SETTLEMENT_VKEY_DIGEST = "bf3d72794436aa2a78a0c0fc6df4059561de55103a913656a0ffbcb24cddddeb"

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
    // Interface v1.1: one public input, the hash of the statement.
    if (vkey.nPublic !== 1) {
        throw new Error(`settlement verification key has ${vkey.nPublic} public inputs, expected 1`)
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
 * or undefined. The circuit hashes balances, magnitudes and account limbs as
 * whole field elements and relies on these bounds for them, and the packing
 * of the public hash is injective only within them.
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
 * points as affine [x, y, "1"] (or infinity [0, 1, 0]) with coordinates below
 * the base field order, no extra fields. One proof has one encoding.
 */
export function settlementProofProblem(proof: unknown): string | undefined {
    if (proof === null || typeof proof !== "object" || Array.isArray(proof)) return "proof is not an object"
    const p = proof as Record<string, unknown>
    for (const key of Object.keys(p)) if (!PROOF_KEYS.has(key)) return `proof has unknown field ${key}`
    if (p.protocol !== "plonk" || p.curve !== "bn128") return "proof is not a bn128 PLONK proof"
    for (const key of POINT_KEYS) {
        const point = p[key]
        if (!Array.isArray(point) || point.length !== 3) return `proof ${key} is not a point`
        if (!point.every(c => canonicalBelow(c, BASE_FIELD_ORDER))) return `proof ${key} has a non-canonical coordinate`
        // The library reads z != 1 as Jacobian coordinates, so one point would
        // have many encodings; only affine [x, y, 1] and infinity [0, 1, 0].
        const infinity = point[0] === "0" && point[1] === "1" && point[2] === "0"
        if (point[2] !== "1" && !infinity) return `proof ${key} is not in affine form`
    }
    for (const key of SCALAR_KEYS) {
        if (!canonicalBelow(p[key], FIELD_ORDER)) return `proof ${key} is not a canonical scalar`
    }
    return undefined
}

/** Test seams: another key file or curve source than the node's own. */
export interface SettlementVerifierDeps {
    vkeyFile?: string
    curve?: () => Promise<unknown>
}

/**
 * True when the proof shows that the public signals (built with
 * settlementPublicSignals from the validator's own state) are the result of
 * the committed transfers.
 *
 * false: the proof is invalid on every honest node (signals out of range,
 * malformed or non-canonical proof, a point off the curve, a failed pairing).
 * Throws SettlementVerifierFault: this node cannot judge the proof (missing
 * or modified verification key, curve not built, verifier error). A caller in
 * block apply must not turn a fault into a failed-batch verdict.
 */
export async function verifySettlementProof(
    publicSignals: bigint[],
    proof: SettlementProof,
    deps: SettlementVerifierDeps = {},
): Promise<boolean> {
    let vkey: unknown
    try {
        vkey = loadSettlementVerificationKey(deps.vkeyFile)
    } catch (error) {
        throw new SettlementVerifierFault(`settlement verification key unusable: ${errorText(error)}`, { cause: error })
    }
    if (publicSignalsProblem(publicSignals) !== undefined) return false
    if (settlementProofProblem(proof) !== undefined) return false
    const publicHash = statementHash(publicSignals)
    if (publicHash === undefined) return false
    const run = verifying.then(async () => {
        let curve: unknown
        try {
            curve = await (deps.curve ?? verifierCurve)()
        } catch (error) {
            throw new SettlementVerifierFault(`bn128 curve unavailable: ${errorText(error)}`, { cause: error })
        }
        try {
            return await plonkVerifyBunStrict(vkey, [publicHash.toString()], proof, curve)
        } catch (error) {
            throw new SettlementVerifierFault(`settlement verifier failed: ${errorText(error)}`, { cause: error })
        }
    })
    verifying = run.then(
        () => undefined,
        () => undefined,
    )
    return run
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// A signer that is not an account of the batch has no hash: no proof can
// show such a statement.
function statementHash(publicSignals: bigint[]): bigint | undefined {
    try {
        return settlementPublicHash(publicSignals)
    } catch (error) {
        if (error instanceof SettlementEncodingError) return undefined
        throw new SettlementVerifierFault(`settlement public hash failed: ${errorText(error)}`, { cause: error })
    }
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
    const { input, publicSignals, publicHash } = buildSettlementCircuitInput(plan)
    const raw = await pool.prove(input)
    if (
        !Array.isArray(raw.publicSignals) ||
        raw.publicSignals.length !== 1 ||
        raw.publicSignals[0] !== publicHash.toString()
    ) {
        throw new Error("settlement prover returned a public input that differs from the plan")
    }
    if (!(await verifySettlementProof(publicSignals, raw.proof))) {
        throw new Error("settlement proof does not verify against the committed key")
    }
    return { proof: raw.proof, publicSignals: publicSignals.map(String) }
}
