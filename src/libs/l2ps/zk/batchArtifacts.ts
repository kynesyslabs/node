import * as fs from "node:fs"
import * as path from "node:path"

// What the batch prover needs on disk, in one place: the prover and the setup
// check ask the same question, so a size one calls usable the other does too.

export const BATCH_SIZES = [5, 10] as const
export type BatchSize = (typeof BATCH_SIZES)[number]

/** A file that exists and holds something: an empty one is a copy that was cut short. */
export const nonEmptyFile = (file: string): boolean => {
    try {
        return fs.statSync(file).size > 0
    } catch {
        return false
    }
}

const isText = (v: unknown): boolean => typeof v === "string" && v !== ""
const isPoint = (v: unknown, coordinates: number): boolean =>
    Array.isArray(v) && v.length >= coordinates && v.every(c => (Array.isArray(c) ? c.length > 0 && c.every(isText) : isText(c)))

const G1_FIELDS = ["Qm", "Ql", "Qr", "Qo", "Qc", "S1", "S2", "S3"] as const

/**
 * Why a batch verification key cannot verify a proof, or undefined when it can.
 * The prover hands the parsed file straight to snarkjs's PLONK verifier, which
 * reads exactly these fields; a key missing one only fails later, on the first
 * proof, so it must not pass as a finished build.
 */
export function rawBatchVkeyProblem(file: string): string | undefined {
    let key: any
    try {
        key = JSON.parse(fs.readFileSync(file, "utf8"))
    } catch (e) {
        return `is not valid JSON (${e instanceof Error ? e.message : String(e)})`
    }
    if (key === null || typeof key !== "object" || Array.isArray(key)) return "is not a JSON object"
    if (key.protocol !== "plonk") return "is not a PLONK verification key"
    if (key.curve !== "bn128") return "is not for the bn128 curve"
    if (!Number.isInteger(key.nPublic) || !Number.isInteger(key.power)) return "has no nPublic or power"
    const missing = [
        ...["k1", "k2", "w"].filter(f => !isText(key[f])),
        ...G1_FIELDS.filter(f => !isPoint(key[f], 2)),
        ...(isPoint(key.X_2, 2) ? [] : ["X_2"]),
    ]
    return missing.length > 0 ? `lacks ${missing.join(", ")}` : undefined
}


export interface BatchFiles {
    dir: string
    zkey: string
    wasm: string
    vkey: string
}

export function batchFiles(keysDir: string, size: number): BatchFiles {
    const dir = path.join(keysDir, `batch_${size}`)
    return {
        dir,
        zkey: path.join(dir, `l2ps_batch_${size}.zkey`),
        wasm: path.join(dir, `l2ps_batch_${size}_js`, `l2ps_batch_${size}.wasm`),
        vkey: path.join(dir, "verification_key.json"),
    }
}

/** Whether a size has everything a proof needs: proving key, circuit, and a verification key that can verify. */
export function isBatchBuilt(keysDir: string, size: number): boolean {
    const f = batchFiles(keysDir, size)
    return nonEmptyFile(f.zkey) && nonEmptyFile(f.wasm) && fs.existsSync(f.vkey) && rawBatchVkeyProblem(f.vkey) === undefined
}
