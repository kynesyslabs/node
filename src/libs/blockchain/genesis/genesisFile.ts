import fs from "fs"
import { resolve } from "path"

export const DEFAULT_GENESIS_FILE = "data/genesis.json"

/**
 * The genesis file this node reads. DEMOS_GENESIS_FILE lets a bare-metal
 * node use the published file where it lies: copying it over the tracked
 * data/genesis.json would mark the build dirty, and a dirty build does not
 * count as the release. Read at call time so tests and tools can set it.
 */
export function genesisFilePath(): string {
    const fromEnv = process.env.DEMOS_GENESIS_FILE
    if (fromEnv && fromEnv.trim().length > 0) return resolve(fromEnv.trim())
    return DEFAULT_GENESIS_FILE
}

/**
 * Whether the genesis file exists. A missing default file means "no genesis
 * here" and the node runs on its built-in schedule; a missing file the
 * operator named is a typo or an unmounted volume, and running on the
 * defaults instead would build a different chain.
 */
export function genesisFileExists(): boolean {
    const file = genesisFilePath()
    if (fs.existsSync(file)) return true
    if (file !== DEFAULT_GENESIS_FILE) {
        throw new Error(
            `[GENESIS] DEMOS_GENESIS_FILE points at ${file}, which does not exist`,
        )
    }
    return false
}
