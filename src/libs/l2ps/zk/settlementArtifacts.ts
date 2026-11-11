import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { nonEmptyFile, rawBatchVkeyProblem } from "./batchArtifacts"

// Where the settlement circuit's files live, shared by the prover, the
// verifier and the setup build so all three read the same paths.

export const SETTLEMENT_CIRCUIT = "l2ps_settlement_10"
export const SETTLEMENT_KEYS_SUBDIR = "settlement_10"

const here = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_KEYS_DIR = path.join(here, "keys")

export interface SettlementFiles {
    dir: string
    zkey: string
    wasm: string
    vkey: string
}

export function settlementFiles(keysDir: string = DEFAULT_KEYS_DIR): SettlementFiles {
    const dir = path.join(keysDir, SETTLEMENT_KEYS_SUBDIR)
    return {
        dir,
        zkey: path.join(dir, `${SETTLEMENT_CIRCUIT}.zkey`),
        wasm: path.join(dir, `${SETTLEMENT_CIRCUIT}_js`, `${SETTLEMENT_CIRCUIT}.wasm`),
        vkey: path.join(dir, "verification_key.json"),
    }
}

/** Whether this node can prove settlements: proving key, circuit and a usable verification key. */
export function isSettlementBuilt(keysDir: string = DEFAULT_KEYS_DIR): boolean {
    const f = settlementFiles(keysDir)
    return nonEmptyFile(f.zkey) && nonEmptyFile(f.wasm) && rawBatchVkeyProblem(f.vkey) === undefined
}
