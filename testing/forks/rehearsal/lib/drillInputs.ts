/**
 * Run inputs of the quorum-loss drill (scenario 12) beyond the genesis
 * contents: the genesis clock, a node-1-only peerlist and an empty snapshot
 * directory, mounted into the nodes through a compose override.
 *
 * A 4-node devnet only forged with all of them. The staging itself is
 * `testing/devnet/quorum-drills/drill_inputs.py`, the code `gen-inputs.py`
 * (run.sh) uses too, so both drills stage the same thing. This file builds the
 * call and the override that mounts the result.
 */

import { spawnSync } from "child_process"
import { writeFileSync } from "fs"
import { resolve } from "path"
import { DEVNET_DIR, REPO_ROOT } from "./devnetControl"

type Genesis = Record<string, any>

/** How far ahead of staging the genesis time is set, as in gen-inputs.py. */
export const GENESIS_DELAY_S = 60

const DRILL_INPUTS_SCRIPT = resolve(DEVNET_DIR, "quorum-drills", "drill_inputs.py")
const GENESIS_IN = "genesis.in.json"

/** The genesis whose fork activations the mainnet-shape drills run with. */
export const LAUNCH_GENESIS_TEMPLATE = resolve(REPO_ROOT, "docs", "mainnet", "genesis.template.json")

/**
 * Copy of `genesis` with the launch fork set of the mainnet genesis template,
 * read now from `template`: active at 0 for every fork the template sets to
 * the number 0, off for null and "FILL: ..." (`drill_inputs.py launch-forks`,
 * the code `run.sh` uses for the same drills).
 */
export function withLaunchForks(genesis: Genesis, template = LAUNCH_GENESIS_TEMPLATE): Genesis {
    const r = spawnSync("python3", ["-I", DRILL_INPUTS_SCRIPT, "launch-forks", "--template", template], {
        encoding: "utf8",
        input: JSON.stringify(genesis),
    })
    if (r.status !== 0) {
        throw new Error(`drill_inputs.py launch-forks failed (exit ${r.status}): ${r.stderr}${r.error ?? ""}`)
    }
    return JSON.parse(r.stdout)
}

/** Where the staged files are, as absolute host paths. */
export interface StagedInputs {
    dir: string
    genesis: string
    peerlist: string
    emptySnapshot: string
}

/** Genesis time, in unix seconds, `delayS` after `nowMs`. */
export function genesisTimestamp(nowMs: number, delayS = GENESIS_DELAY_S): number {
    return Math.floor(nowMs / 1_000) + delayS
}

/**
 * Validator pubkeys of a drill genesis in node order, and node-1's RPC port
 * from its `connection_url`. Taken from the genesis so that ports and keys
 * have one source.
 */
export function peerSeedFromGenesis(genesis: Genesis): { pubkeys: string[]; node1Port: string } {
    const validators: unknown = genesis.validators
    if (!Array.isArray(validators) || validators.length === 0) {
        throw new Error("drill genesis has no validators")
    }
    const pubkeys = validators.map(v => String(v?.address))
    const port = new URL(String(validators[0]?.connection_url)).port
    if (!port) throw new Error("node-1 connection_url in the drill genesis has no port")
    return { pubkeys, node1Port: port }
}

/**
 * Writes the genesis (with its time set to `genesisTs`), a peerlist seeding
 * node-1 only and an empty snapshot directory into `dir`, through
 * `drill_inputs.py`. `dir` must exist.
 */
export function stageDrillInputs(opts: {
    genesis: Genesis
    genesisTs: number
    dir: string
}): StagedInputs {
    const { pubkeys, node1Port } = peerSeedFromGenesis(opts.genesis)
    const input = resolve(opts.dir, GENESIS_IN)
    writeFileSync(input, JSON.stringify(opts.genesis, null, 4) + "\n")
    const r = spawnSync(
        "python3",
        [
            "-I",
            DRILL_INPUTS_SCRIPT,
            "stage",
            "--genesis",
            input,
            ...pubkeys.flatMap(p => ["--pub", p]),
            "--node1-port",
            node1Port,
            "--genesis-ts",
            String(opts.genesisTs),
            "--out-dir",
            opts.dir,
        ],
        { encoding: "utf8" },
    )
    if (r.status !== 0) {
        throw new Error(`drill_inputs.py stage failed (exit ${r.status}): ${r.stderr}${r.error ?? ""}`)
    }
    return {
        dir: opts.dir,
        genesis: resolve(opts.dir, "genesis.json"),
        peerlist: resolve(opts.dir, "peerlist.json"),
        emptySnapshot: resolve(opts.dir, "empty-snapshot"),
    }
}

/**
 * Compose override that mounts the staged files into each of `nodeIds`:
 * the genesis and the node-1-only peerlist (replacing the base file's peerlist
 * mount, which has the same container path) and the empty directory over
 * `/app/data/snapshot`, which hides the image's testnet snapshot.
 */
export function drillOverrideYaml(staged: StagedInputs, nodeIds: number[]): string {
    for (const p of [staged.genesis, staged.peerlist, staged.emptySnapshot]) {
        if (/[:\n"]/.test(p)) throw new Error(`path not usable in a compose volume: ${p}`)
    }
    const mounts = [
        `${staged.peerlist}:/app/demos_peerlist.json:ro`,
        `${staged.genesis}:/app/data/genesis.json:ro`,
        `${staged.emptySnapshot}:/app/data/snapshot:ro`,
    ]
    const lines = ["services:"]
    for (const id of nodeIds) {
        lines.push(`  node-${id}:`, "    volumes:")
        for (const m of mounts) lines.push(`      - "${m}"`)
    }
    return lines.join("\n") + "\n"
}
