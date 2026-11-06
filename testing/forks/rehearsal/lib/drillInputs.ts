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
import { systemBinary } from "./systemBinary"

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
 * the number 0, off for null and "FILL: ...", and off for the forks the drills
 * exclude by name (`LAUNCH_EXCLUDED_FORKS`: identityCarryover, which needs a
 * genesis snapshot) (`drill_inputs.py launch-forks`, the code `run.sh` uses for
 * the same drills).
 */
export function withLaunchForks(genesis: Genesis, template = LAUNCH_GENESIS_TEMPLATE): Genesis {
    const r = spawnSync(systemBinary("python3"), ["-I", DRILL_INPUTS_SCRIPT, "launch-forks", "--template", template], {
        encoding: "utf8",
        input: JSON.stringify(genesis),
    })
    if (r.status !== 0) {
        throw new Error(`drill_inputs.py launch-forks failed (exit ${r.status}): ${r.stderr}${r.error ?? ""}`)
    }
    return JSON.parse(r.stdout)
}

/**
 * The excluded forks `template` activates at 0, as name -> reason: the forks
 * `withLaunchForks` took out of the template's launch set
 * (`drill_inputs.py launch-excluded`).
 */
export function launchExcluded(template = LAUNCH_GENESIS_TEMPLATE): Record<string, string> {
    const r = spawnSync(systemBinary("python3"), ["-I", DRILL_INPUTS_SCRIPT, "launch-excluded", "--template", template], {
        encoding: "utf8",
    })
    if (r.status !== 0) {
        throw new Error(`drill_inputs.py launch-excluded failed (exit ${r.status}): ${r.stderr}${r.error ?? ""}`)
    }
    return JSON.parse(r.stdout)
}

/**
 * The last "Refusing to boot" line of a node log, or null. A node that refuses
 * its genesis (findGenesisBlock.ts `refuse()`, e.g. a fork that needs a
 * snapshot) never serves, and the drill would otherwise end as a timeout on
 * the baseline height.
 */
export function bootRefusalLine(nodeLog: string): string | null {
    const lines = nodeLog.split("\n").filter(l => /refusing to boot/i.test(l))
    return lines.length > 0 ? lines[lines.length - 1].trim().slice(0, 600) : null
}

/** The bounds of a `readLogTail` read: its last lines, and how long it may take. */
export const BOOT_LOG_TAIL_LINES = 400
export const BOOT_LOG_TIMEOUT_MS = 30_000

/**
 * The last `BOOT_LOG_TAIL_LINES` lines of `service`'s log
 * (`docker compose logs --tail`, as `logs()` reads it), within `timeoutMs`.
 * Throws, saying why, when docker fails or does not finish in time: the read
 * runs on a failure path, which must not hang on a stalled daemon. `docker`
 * is for the tests.
 */
export function readLogTail(service: string, timeoutMs = BOOT_LOG_TIMEOUT_MS, docker = systemBinary("docker")): string {
    const r = spawnSync(docker, ["compose", "logs", "--no-color", "--tail", String(BOOT_LOG_TAIL_LINES), service], {
        cwd: DEVNET_DIR,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs,
        // a child that ignores SIGTERM would keep spawnSync waiting
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024 * 1024,
    })
    if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
        throw new Error(`docker compose logs did not finish within ${timeoutMs} ms`)
    }
    if (r.error) throw new Error(`docker compose logs failed: ${r.error.message}`)
    if (r.status !== 0) {
        throw new Error(`docker compose logs failed (exit ${r.status}): ${(r.stderr ?? "").trim().slice(0, 300)}`)
    }
    return (r.stdout ?? "") + (r.stderr ?? "")
}

/**
 * `e` with the "Refusing to boot" line of every service that logged one, so a
 * refused genesis is not just a timeout, and with every log that could not be
 * read named as unreadable, with why, not skipped. Only the message changes:
 * the caller throws `e` either way.
 */
export function withBootRefusals(e: unknown, services: string[], readLog: (service: string) => string = s => readLogTail(s)): unknown {
    if (!(e instanceof Error)) return e
    const lines = services.flatMap(service => {
        try {
            const line = bootRefusalLine(readLog(service))
            return line === null ? [] : [`${service}: ${line}`]
        } catch (err) {
            return [`${service}: log unreadable (${err instanceof Error ? err.message : String(err)})`]
        }
    })
    if (lines.length > 0) e.message += `\nnode log:\n  ${lines.join("\n  ")}`
    return e
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
        systemBinary("python3"),
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
 *
 * It also pins each node's CONSENSUS_TIME to `consensusTimeS`. Compose would
 * otherwise also take it from testing/devnet/.env, which the drill does not
 * read, and the drill's hold and settle windows are counted in its rounds.
 */
export function drillOverrideYaml(
    staged: StagedInputs,
    nodeIds: number[],
    opts: { consensusTimeS: number },
): string {
    if (!Number.isInteger(opts.consensusTimeS) || opts.consensusTimeS <= 0) {
        throw new Error(`consensus time must be a positive whole number of seconds: ${opts.consensusTimeS}`)
    }
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
        lines.push("    environment:", `      - CONSENSUS_TIME=${opts.consensusTimeS}`)
    }
    return lines.join("\n") + "\n"
}
