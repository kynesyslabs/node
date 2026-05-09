/**
 * Devnet orchestration helpers for the fork-activation rehearsal harness.
 *
 * Each helper here shells out to `docker compose` against
 * `testing/devnet/docker-compose.yml`. We never reach into the running
 * node process — observation goes through RPC + Postgres only. That
 * keeps the rehearsal honest about what an external operator can observe.
 *
 * All paths are absolute. Scenarios should never `cd`; the rehearsal
 * harness must remain location-independent.
 */

import { spawn, spawnSync } from "child_process"
import { existsSync, mkdirSync, copyFileSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import { fileURLToPath } from "url"

// Bun supports `import.meta.dirname` natively, but in TypeScript with the
// stock ts lib the field is typed as `string | undefined`, and falling
// back via `fileURLToPath` keeps the harness portable to Node-driven
// tooling (e.g. ts-node) too.
const moduleDir = dirname(fileURLToPath(import.meta.url))

/** Repo root, derived once. */
export const REPO_ROOT = resolve(moduleDir, "..", "..", "..", "..")
/** Devnet directory (compose context). */
export const DEVNET_DIR = resolve(REPO_ROOT, "testing", "devnet")
/** Rehearsal directory. */
export const REHEARSAL_DIR = resolve(REPO_ROOT, "testing", "forks", "rehearsal")
/** Production genesis path (must NEVER be edited). */
export const PROD_GENESIS_PATH = resolve(REPO_ROOT, "data", "genesis.json")
/** Backup of the production genesis. */
export const PROD_GENESIS_BACKUP_PATH = resolve(
    REPO_ROOT,
    "data",
    "genesis.json.rehearsal-backup",
)
/** Pre-built rehearsal genesis files. */
export const GENESIS_PRE_FORK = resolve(
    REHEARSAL_DIR,
    "genesis",
    "genesis-pre-fork.json",
)
export const GENESIS_FORK_LOW = resolve(
    REHEARSAL_DIR,
    "genesis",
    "genesis-fork-low.json",
)
export const GENESIS_FORK_MID = resolve(
    REHEARSAL_DIR,
    "genesis",
    "genesis-fork-mid.json",
)
export const GENESIS_FORK_OVERFLOW = resolve(
    REHEARSAL_DIR,
    "genesis",
    "genesis-fork-overflow.json",
)

/**
 * Runs `docker compose` (cwd=DEVNET_DIR) with the supplied args.
 * Throws on non-zero exit.
 *
 * Note: we use `spawnSync` for ergonomic top-to-bottom scripts. Wall
 * time is dominated by container boot/teardown, not Node IPC, so the
 * blocking model is fine and dramatically simplifies error handling.
 */
export function compose(args: string[], opts: { allowFail?: boolean } = {}): string {
    const result = spawnSync("docker", ["compose", ...args], {
        cwd: DEVNET_DIR,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    })
    if (result.status !== 0 && !opts.allowFail) {
        const out = result.stdout ?? ""
        const err = result.stderr ?? ""
        throw new Error(
            `docker compose ${args.join(" ")} failed (exit ${result.status})\n${err}\n${out}`,
        )
    }
    return (result.stdout ?? "") + (result.stderr ?? "")
}

/**
 * Brings up the devnet from a clean state (no volumes, no images cached
 * across runs of `--build`). The caller is responsible for genesis /
 * peerlist staging beforehand.
 *
 * @param services Optional list of services to start. Defaults to "all".
 * @param profiles Optional docker-compose profiles to enable.
 */
export function up(opts: {
    services?: string[]
    profiles?: string[]
    build?: boolean
} = {}): void {
    const args: string[] = []
    for (const p of opts.profiles ?? []) {
        args.push("--profile", p)
    }
    args.push("up", "-d")
    if (opts.build) args.push("--build")
    if (opts.services && opts.services.length > 0) {
        args.push(...opts.services)
    }
    compose(args)
}

/** Tears the devnet down and wipes ephemeral volumes. Idempotent. */
export function downHard(opts: { profiles?: string[] } = {}): void {
    const args: string[] = []
    for (const p of opts.profiles ?? []) {
        args.push("--profile", p)
    }
    args.push("down", "-v", "--remove-orphans")
    compose(args, { allowFail: true })
}

/** Stops a service without removing volumes. */
export function stopService(name: string): void {
    compose(["stop", name])
}

/** Starts a stopped service. */
export function startService(name: string): void {
    compose(["start", name])
}

/** Restarts a service. */
export function restartService(name: string): void {
    compose(["restart", name])
}

/** Kill (SIGKILL) a service container. Used for ungraceful-shutdown tests. */
export function killService(name: string): void {
    spawnSync("docker", ["kill", `demos-devnet-${name}`], {
        stdio: "ignore",
    })
}

/** Returns the last `lines` log lines for a service. */
export function logs(service: string, lines = 200): string {
    return compose(["logs", "--no-color", "--tail", String(lines), service])
}

/**
 * Returns the FULL log buffer for a service (no tail truncation). Used
 * by scenario 5 to find a `CAP applied` warning emitted near the
 * fork-activation height — by the time the scenario asserts, hundreds
 * of post-fork log lines have flushed past the migration banner so the
 * `--tail 800` default in {@link logs} would miss it. The output can be
 * tens of thousands of lines but is fine for one-shot grep.
 */
export function logsFull(service: string): string {
    return compose(["logs", "--no-color", service])
}

/**
 * Stages a rehearsal genesis at the production genesis path.
 *
 * The devnet image bakes `data/genesis.json` at build time and bind-mounts
 * are not used for the genesis (see DEVNET_READINESS Q4). To make a
 * scenario use a non-default genesis, we copy it over `data/genesis.json`
 * BEFORE building the image. The harness backs up the production file
 * once (idempotent) and restores it in `restoreProductionGenesis()`.
 *
 * IMPORTANT: callers must always pair `stageGenesis()` with a final
 * `restoreProductionGenesis()` (use `try { ... } finally { ... }`) or the
 * working tree will be left in a non-production state.
 */
export function stageGenesis(rehearsalGenesisPath: string): void {
    if (!existsSync(rehearsalGenesisPath)) {
        throw new Error(`Genesis not found: ${rehearsalGenesisPath}`)
    }
    if (!existsSync(PROD_GENESIS_BACKUP_PATH)) {
        // Make a one-time backup of whatever was there.
        if (existsSync(PROD_GENESIS_PATH)) {
            copyFileSync(PROD_GENESIS_PATH, PROD_GENESIS_BACKUP_PATH)
        }
    }
    copyFileSync(rehearsalGenesisPath, PROD_GENESIS_PATH)
}

/**
 * Restores the production genesis from the rehearsal backup. Idempotent
 * — calling twice is safe; calling without a prior `stageGenesis()` is
 * a no-op.
 */
export function restoreProductionGenesis(): void {
    if (existsSync(PROD_GENESIS_BACKUP_PATH)) {
        copyFileSync(PROD_GENESIS_BACKUP_PATH, PROD_GENESIS_PATH)
    }
}

/**
 * Runs `setup.sh` to (re)generate identities + peerlist. Pass
 * `nodeCount=5` for the rehearsal scenario that needs a fresh joiner.
 */
export function regenerateIdentities(nodeCount = 4): void {
    if (!existsSync(resolve(DEVNET_DIR, "identities"))) {
        mkdirSync(resolve(DEVNET_DIR, "identities"))
    }
    const env = { ...process.env, NODE_COUNT: String(nodeCount) }
    const r1 = spawnSync(resolve(DEVNET_DIR, "scripts", "generate-identities.sh"), {
        env,
        cwd: DEVNET_DIR,
        encoding: "utf8",
        stdio: "pipe",
    })
    if (r1.status !== 0) {
        throw new Error(`generate-identities.sh failed:\n${r1.stderr}`)
    }
    const r2 = spawnSync(resolve(DEVNET_DIR, "scripts", "generate-peerlist.sh"), {
        env,
        cwd: DEVNET_DIR,
        encoding: "utf8",
        stdio: "pipe",
    })
    if (r2.status !== 0) {
        throw new Error(`generate-peerlist.sh failed:\n${r2.stderr}`)
    }
}

/** Sleeps for `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
    return new Promise(resolve_ => setTimeout(resolve_, ms))
}

/**
 * Generic poll helper. Calls `predicate` every `intervalMs` until it
 * returns truthy or `timeoutMs` elapses.
 *
 * @returns The truthy value returned by `predicate`.
 * @throws if `timeoutMs` is exceeded; the error message includes
 *   `description` for log clarity.
 */
export async function waitFor<T>(
    predicate: () => Promise<T | null | undefined | false>,
    opts: { description: string; timeoutMs?: number; intervalMs?: number },
): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? 120_000
    const intervalMs = opts.intervalMs ?? 1_000
    const start = Date.now()
    let lastErr: unknown = null
    while (Date.now() - start < timeoutMs) {
        try {
            const result = await predicate()
            if (result) return result as T
        } catch (e) {
            lastErr = e
        }
        await sleep(intervalMs)
    }
    const lastErrMsg =
        lastErr instanceof Error ? `; lastError=${lastErr.message}` : ""
    throw new Error(
        `Timed out after ${timeoutMs}ms waiting for: ${opts.description}${lastErrMsg}`,
    )
}

/**
 * Echoes a banner. Scenario scripts call this to delineate phases in
 * mixed log output.
 */
export function banner(title: string): void {
    const line = "=".repeat(72)
    process.stdout.write(`\n${line}\n${title}\n${line}\n`)
}

/** Background log writer for a service (returned handle stops streaming). */
export function streamLogsToFile(
    service: string,
    outPath: string,
): { stop: () => void } {
    if (!existsSync(dirname(outPath))) {
        mkdirSync(dirname(outPath), { recursive: true })
    }
    const child = spawn(
        "docker",
        ["compose", "logs", "-f", "--no-color", service],
        {
            cwd: DEVNET_DIR,
            stdio: ["ignore", "pipe", "pipe"],
        },
    )
    const fd = require("fs").openSync(outPath, "a")
    child.stdout?.on("data", chunk => writeFileSync(fd, chunk))
    child.stderr?.on("data", chunk => writeFileSync(fd, chunk))
    return {
        stop: () => {
            try {
                child.kill("SIGTERM")
            } catch {
                /* ignore */
            }
            try {
                require("fs").closeSync(fd)
            } catch {
                /* ignore */
            }
        },
    }
}
