/* eslint-disable no-console */
/**
 * State Snapshot Exporter.
 *
 * Exports the live node database into the `data/snapshot/` JSONL + manifest
 * format consumed at clean-DB boot by `src/libs/blockchain/genesis/loadSnapshot.ts`.
 * The output is a drop-in replacement for the shipped snapshot: boot a node
 * with an empty chain DB and it restores everything in this directory.
 *
 * Three tables are exported:
 *   - gcr_main             -> gcr_main.jsonl
 *   - gcr_storageprogram   -> gcr_storageprogram.jsonl
 *   - identity_commitments -> identity_commitments.jsonl
 *
 * Genesis-style operator transforms (matching the canonical snapshot):
 *   - gcr_main.nonce        -> 0
 *   - gcr_main.assignedTxs  -> [] (now a separate gcr_assigned_txs table)
 *   - identity_commitments  -> drop the test row (provider='test', leaf_index=-1)
 *
 * The exporter computes sha256 / row counts / balance + size sums itself, so
 * the manifest is always self-consistent, and finishes by re-running the
 * shared `verifySnapshot()` integrity gate as a self-check.
 *
 * Usage:
 *   bun run snapshot:export [--docker | --native] [--outdir <dir>] [--service <name>]
 *
 * Mode (how postgres is reached):
 *   --docker   (default) run psql inside the compose postgres container via
 *              `docker compose exec -T <service> psql ...`. No host port needed.
 *   --native   run psql on the host against PG_HOST/PG_PORT (Config defaults
 *              localhost:5332, demosuser/demos). Requires a host-reachable DB.
 *
 * Flags:
 *   --outdir <dir>   output directory. Default data/snapshot.
 *                    (--out is accepted as a legacy alias.)
 *   --service <name> compose service name for --docker. Default postgres.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { hostname } from "node:os"
import { resolve } from "node:path"

import { verifySnapshot } from "../../src/libs/blockchain/genesis/verifySnapshot"

const REPO_ROOT = resolve(import.meta.dir, "..", "..")

// ---------- helpers ----------

function exitWith(msg: string, code = 1): never {
    console.error(msg)
    process.exit(code)
}

const green = (s: string): string => `\x1b[32m${s}\x1b[0m`
const yellow = (s: string): string => `\x1b[33m${s}\x1b[0m`

export function parseArgs(argv: string[]): {
    flags: Record<string, string>
} {
    const flags: Record<string, string> = {}
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (!arg.startsWith("--")) continue
        const key = arg.slice(2)
        const next = argv[i + 1]
        if (next === undefined || next.startsWith("--")) {
            flags[key] = "true"
        } else {
            flags[key] = next
            i++
        }
    }
    return { flags }
}

const DEFAULT_OUT_DIR_SEGMENTS = ["data", "snapshot"] as const

/**
 * Resolve the snapshot output directory from parsed flags.
 *
 * `--outdir <dir>` is the primary flag; `--out <dir>` is kept as a legacy
 * alias. When both are passed, `--outdir` wins. With neither, the default is
 * `<repoRoot>/data/snapshot`.
 */
export function resolveOutDir(
    flags: Record<string, string>,
    repoRoot: string = REPO_ROOT,
): string {
    const rawOutDir = flags.outdir ?? flags.out
    if (rawOutDir === undefined) {
        return resolve(repoRoot, ...DEFAULT_OUT_DIR_SEGMENTS)
    }
    // parseArgs stores valueless flags as the string "true".
    if (rawOutDir === "true") {
        throw new Error("--outdir requires a directory path")
    }
    return resolve(rawOutDir)
}

// PG connection params, mirroring src/config envKeys + defaults.
const PG = {
    host: process.env.PG_HOST ?? "localhost",
    port: process.env.PG_PORT ?? "5332",
    user: process.env.PG_USER ?? "demosuser",
    password: process.env.PG_PASSWORD ?? "demospassword",
    database: process.env.PG_DATABASE ?? "demos",
}

const PSQL_FLAGS = ["-At", "-P", "pager=off", "--no-psqlrc"]

type Runner = (sql: string) => { cmd: string[]; env: NodeJS.ProcessEnv }

function makeRunner(mode: "docker" | "native", service: string): Runner {
    if (mode === "native") {
        const conninfo = `postgresql://${PG.user}@${PG.host}:${PG.port}/${PG.database}`
        return (sql: string) => ({
            cmd: ["psql", conninfo, ...PSQL_FLAGS, "-c", sql],
            env: { ...process.env, PGPASSWORD: PG.password },
        })
    }
    // docker: query runs inside the container; auth is local to the container.
    return (sql: string) => ({
        cmd: [
            "docker",
            "compose",
            "exec",
            "-T",
            service,
            "psql",
            "-U",
            PG.user,
            "-d",
            PG.database,
            ...PSQL_FLAGS,
            "-c",
            sql,
        ],
        env: process.env,
    })
}

async function psqlRaw(runner: Runner, sql: string): Promise<string> {
    const { cmd, env } = runner(sql)
    const proc = Bun.spawn({ cmd, env, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    if (code !== 0) {
        exitWith(
            `psql failed (exit ${code}) for: ${cmd.slice(0, 4).join(" ")} ...\n${stderr.trim()}`,
        )
    }
    return stdout
}

// ---------- SQL (genesis-style transforms baked in) ----------

const SQL_GCR_MAIN = `SELECT json_build_object(
  'pubkey', pubkey,
  'assignedTxs', json_build_array(),
  'nonce', 0,
  'balance', balance::text,
  'identities', identities,
  'points', points,
  'referralInfo', "referralInfo",
  'flagged', flagged,
  'flaggedReason', "flaggedReason",
  'reviewed', reviewed,
  'createdAt', "createdAt",
  'updatedAt', "updatedAt"
) FROM gcr_main ORDER BY pubkey`

const SQL_STORAGE = `SELECT json_build_object(
  'storageAddress', "storageAddress",
  'owner', owner,
  'programName', "programName",
  'encoding', encoding,
  'data', data,
  'sizeBytes', "sizeBytes",
  'acl', acl,
  'metadata', metadata,
  'storageLocation', "storageLocation",
  'ipfsCid', "ipfsCid",
  'salt', salt,
  'createdByTx', "createdByTx",
  'lastModifiedByTx', "lastModifiedByTx",
  'totalFeesPaid', "totalFeesPaid"::text,
  'isDeleted', "isDeleted",
  'interactionTxs', "interactionTxs",
  'deletedByTx', "deletedByTx",
  'createdAt', "createdAt",
  'updatedAt', "updatedAt"
) FROM gcr_storageprogram ORDER BY "storageAddress"`

const SQL_IDENTITY = `SELECT json_build_object(
  'commitment_hash', commitment_hash,
  'leaf_index', leaf_index,
  'provider', provider,
  'block_number', block_number,
  'transaction_hash', transaction_hash,
  'timestamp', timestamp::text,
  'created_at', created_at
) FROM identity_commitments
WHERE NOT (provider = 'test' AND leaf_index = -1)
ORDER BY commitment_hash`

const SQL_VALIDATORS = `SELECT json_build_object(
  'address', address,
  'status', status,
  'connection_url', connection_url,
  'staked_amount', staked_amount,
  'first_seen', first_seen,
  'valid_at', valid_at,
  'unstake_requested_at', unstake_requested_at,
  'unstake_available_at', unstake_available_at
) FROM validators ORDER BY address`

const SQL_FORK_STATE = `SELECT json_build_object(
  'fork_name', fork_name,
  'applied', applied,
  'applied_at_block', applied_at_block::text,
  'applied_at', applied_at,
  'pre_sum_dem', pre_sum_dem,
  'post_sum_os', post_sum_os,
  'gcr_v2_row_count', gcr_v2_row_count,
  'legacy_row_count', legacy_row_count,
  'validators_row_count', validators_row_count,
  'capped_count', capped_count,
  'total_value_lost_os', total_value_lost_os,
  'malformed_validators_count', malformed_validators_count
) FROM fork_state ORDER BY fork_name`

const SQL_DROPPED_IDENTITY =
    "SELECT count(*) FROM identity_commitments WHERE provider = 'test' AND leaf_index = -1"
const SQL_LATEST_BLOCK =
    "SELECT coalesce(number::text, '') || '|' || coalesce(hash, '') FROM blocks ORDER BY number DESC LIMIT 1"

// ---------- table export ----------

type FileStats = {
    sha256: string
    rows: number
    balanceSum: bigint
    sizeBytesSum: number
}

/**
 * Stream a table's JSONL out of psql, re-serialize each row to compact JSON,
 * write the file, and compute sha256 / rows / sums in one pass.
 */
async function exportTable(
    runner: Runner,
    name: string,
    sql: string,
    sumField: "balance" | "sizeBytes" | null,
    outDir: string,
): Promise<FileStats> {
    const raw = await psqlRaw(runner, sql)
    const lines = raw.split("\n").filter(l => l.trim().length > 0)

    let balanceSum = 0n
    let sizeBytesSum = 0
    const compact: string[] = []

    for (let i = 0; i < lines.length; i++) {
        let obj: Record<string, unknown>
        try {
            obj = JSON.parse(lines[i])
        } catch (e) {
            exitWith(
                `${name}: row ${i + 1} is not valid JSON: ${
                    e instanceof Error ? e.message : String(e)
                }`,
            )
        }
        if (sumField === "balance") {
            balanceSum += BigInt(obj.balance as string)
        } else if (sumField === "sizeBytes") {
            sizeBytesSum += obj.sizeBytes as number
        }
        compact.push(JSON.stringify(obj))
    }

    // 0 rows -> 0-byte file (matches the empty identity_commitments.jsonl
    // convention; sha256 of "" is the canonical empty hash).
    const content = compact.length > 0 ? compact.join("\n") + "\n" : ""
    const sha256 = createHash("sha256").update(content).digest("hex")

    await writeFile(resolve(outDir, name), content)

    return { sha256, rows: compact.length, balanceSum, sizeBytesSum }
}

// ---------- main ----------

async function main(): Promise<void> {
    const { flags } = parseArgs(process.argv.slice(2))

    if (flags.docker && flags.native) {
        exitWith("pass only one of --docker / --native")
    }
    const mode: "docker" | "native" = flags.native ? "native" : "docker"
    const service = typeof flags.service === "string" ? flags.service : "postgres"
    const outDir = resolveOutDir(flags)

    const runner = makeRunner(mode, service)

    console.log("------------------------------------------")
    console.log(`Mode:    ${mode}${mode === "docker" ? ` (service: ${service})` : ""}`)
    console.log(`Target:  ${PG.user}@${mode === "native" ? `${PG.host}:${PG.port}` : service}/${PG.database}`)
    console.log(`Out dir: ${outDir}`)
    console.log("------------------------------------------\n")

    // Source metadata from the live chain + server.
    const pgVersion = (await psqlRaw(runner, "SHOW server_version")).trim()
    const latestBlockRaw = (await psqlRaw(runner, SQL_LATEST_BLOCK)).trim()
    const [blockHeightStr, blockHash] = latestBlockRaw.split("|")
    const droppedIdentity = Number.parseInt(
        (await psqlRaw(runner, SQL_DROPPED_IDENTITY)).trim() || "0",
        10,
    )
    const pkg = JSON.parse(
        await readFile(resolve(REPO_ROOT, "package.json"), "utf8"),
    )

    await mkdir(outDir, { recursive: true })

    console.log("Exporting gcr_main...")
    const gcrMain = await exportTable(runner, "gcr_main.jsonl", SQL_GCR_MAIN, "balance", outDir)
    console.log("Exporting gcr_storageprogram...")
    const storage = await exportTable(runner, "gcr_storageprogram.jsonl", SQL_STORAGE, "sizeBytes", outDir)
    console.log("Exporting identity_commitments...")
    const identity = await exportTable(runner, "identity_commitments.jsonl", SQL_IDENTITY, null, outDir)
    console.log("Exporting validators...")
    const validators = await exportTable(runner, "validators.jsonl", SQL_VALIDATORS, null, outDir)

    // fork_state is tiny (one row per fork) and describes the snapshot itself,
    // so it rides in the manifest rather than its own file. The restore path
    // reads it to decide, per fork, whether to run the migration (pre-fork
    // snapshot) or seed the marker and skip it (post-fork snapshot).
    const forkStateRaw = (await psqlRaw(runner, SQL_FORK_STATE)).trim()
    const forkState =
        forkStateRaw.length > 0
            ? forkStateRaw
                  .split("\n")
                  .filter(l => l.trim().length > 0)
                  .map(l => JSON.parse(l))
            : []

    const manifest = {
        schemaVersion: 2,
        source: {
            host: hostname(),
            chain_block_height: Number.parseInt(blockHeightStr || "0", 10),
            chain_block_hash: blockHash || "",
            node_version: pkg.version,
            pg_version: pgVersion,
            dumped_at: new Date().toISOString(),
        },
        files: {
            "gcr_main.jsonl": {
                sha256: gcrMain.sha256,
                rows: gcrMain.rows,
                balance_sum: gcrMain.balanceSum.toString(),
            },
            "gcr_storageprogram.jsonl": {
                sha256: storage.sha256,
                rows: storage.rows,
                size_bytes_sum: storage.sizeBytesSum,
            },
            "identity_commitments.jsonl": {
                sha256: identity.sha256,
                rows: identity.rows,
            },
            "validators.jsonl": {
                sha256: validators.sha256,
                rows: validators.rows,
            },
        },
        fork_state: forkState,
        transforms_applied: {
            nonces_reset_to_zero: true,
            assigned_txs_emptied: true,
            test_identity_commitments_dropped: droppedIdentity,
        },
    }

    await writeFile(
        resolve(outDir, "manifest.json"),
        JSON.stringify(manifest, null, 2) + "\n",
    )

    // Self-check with the same integrity gate the node boot uses.
    await verifySnapshot(outDir)

    console.log(green("\n✅ snapshot exported and verified"))
    console.log(
        `   gcr_main=${gcrMain.rows} balance_sum=${gcrMain.balanceSum} storage=${storage.rows} size_bytes_sum=${storage.sizeBytesSum} identity=${identity.rows} validators=${validators.rows}`,
    )
    const appliedForks = forkState
        .filter((f: { applied?: boolean }) => f.applied)
        .map((f: { fork_name: string }) => f.fork_name)
    console.log(
        `   fork_state: ${forkState.length} row(s)${appliedForks.length ? ` (applied: ${appliedForks.join(", ")})` : ""}`,
    )
    console.log(
        `   source block ${manifest.source.chain_block_height} @ ${manifest.source.chain_block_hash.slice(0, 12)}... pg ${pgVersion}`,
    )
    if (droppedIdentity > 0) {
        console.log(yellow(`   dropped ${droppedIdentity} test identity commitment(s)`))
    }
}

if (import.meta.main) {
    main().catch(e =>
        exitWith(e instanceof Error ? e.stack ?? e.message : String(e)),
    )
}
