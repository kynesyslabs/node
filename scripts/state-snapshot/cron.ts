/* eslint-disable no-console */
/**
 * Snapshot export cron manager (Linux).
 *
 * Default action installs a crontab entry that runs a snapshot export every
 * --interval hours into <basedir>/<YYYY-MM-DD_HH-MM>, then prunes snapshot
 * directories older than --keep-days. Pruning only runs after a successful
 * export (same cycle, chained on success), so if snapshot generation stops
 * or starts failing, existing snapshots are never deleted.
 *
 * Usage:
 *   bun run snapshot:cron [--interval <hours>] [--basedir <dir>] [--keep-days <n>]
 *   bun run snapshot:cron --stop    remove the installed cron entry
 *   bun run snapshot:cron --run     internal: one export + prune cycle
 *                                   (this is what the cron entry invokes)
 *
 * Defaults:
 *   --interval  6 hours
 *   --basedir   ~/demosdb
 *   --keep-days 7
 */

import { join, resolve } from "node:path"
import { homedir } from "node:os"
import { mkdir, readdir, rm } from "node:fs/promises"

import { parseArgs } from "./export"

const REPO_ROOT = resolve(import.meta.dir, "..", "..")
const CRON_SCRIPT = "scripts/state-snapshot/cron.ts"
const EXPORT_SCRIPT = "scripts/state-snapshot/export.ts"

// Marker appended to the crontab line so install/--stop can find it. The
// shell treats it as a trailing comment, so it never affects the command.
const CRON_MARKER = "#demos-snapshot-cron"

const DEFAULT_INTERVAL_HOURS = 6
const DEFAULT_KEEP_DAYS = 7
const DEFAULT_BASEDIR = join(homedir(), "snapshots")
const LOG_FILE_NAME = "export.log"

// Matches dated snapshot dir names produced by --run: YYYY-MM-DD_HH-MM.
const SNAPSHOT_DIR_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})$/
const MS_PER_DAY = 24 * 60 * 60 * 1000

// cron's default PATH is /usr/bin:/bin which usually misses docker.
const CRON_PATH = "/usr/local/bin:/usr/bin:/bin"

// ---------- helpers ----------

function exitWith(msg: string, code = 1): never {
    console.error(msg)
    process.exit(code)
}

const green = (s: string): string => `\x1b[32m${s}\x1b[0m`

function parseIntFlag(
    raw: string | undefined,
    fallback: number,
    label: string,
): number {
    if (raw === undefined) return fallback
    const value = Number.parseInt(raw, 10)
    if (!Number.isInteger(value) || String(value) !== raw) {
        exitWith(`${label} must be an integer (got "${raw}")`)
    }
    return value
}

export function timestampDirName(date: Date): string {
    const pad = (n: number): string => String(n).padStart(2, "0")
    return (
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-` +
        `${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}`
    )
}

/** Parse a dated snapshot dir name back to epoch ms, or null if no match. */
export function snapshotDirTimestamp(name: string): number | null {
    const match = SNAPSHOT_DIR_RE.exec(name)
    if (!match) return null
    const [, year, month, day, hour, minute] = match
    const ts = new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
    ).getTime()
    return Number.isNaN(ts) ? null : ts
}

export function buildCronLine(opts: {
    intervalHours: number
    basedir: string
    keepDays: number
    bunPath: string
    repoRoot: string
}): string {
    const { intervalHours, basedir, keepDays, bunPath, repoRoot } = opts
    const logFile = join(basedir, LOG_FILE_NAME)
    return (
        `0 */${intervalHours} * * * ` +
        `cd "${repoRoot}" && PATH="${CRON_PATH}" "${bunPath}" ${CRON_SCRIPT} ` +
        `--run --basedir "${basedir}" --keep-days ${keepDays} ` +
        `>> "${logFile}" 2>&1 ${CRON_MARKER}`
    )
}

// ---------- crontab IO ----------

async function readCrontab(): Promise<string[]> {
    const proc = Bun.spawn({
        cmd: ["crontab", "-l"],
        stdout: "pipe",
        stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    if (code !== 0) {
        // "no crontab for <user>" is a normal empty state.
        if (/no crontab/i.test(stderr)) return []
        exitWith(`crontab -l failed (exit ${code}):\n${stderr.trim()}`)
    }
    const lines = stdout.split("\n")
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
        lines.pop()
    }
    return lines
}

async function writeCrontab(lines: string[]): Promise<void> {
    const content = lines.length > 0 ? lines.join("\n") + "\n" : "\n"
    const proc = Bun.spawn({
        cmd: ["crontab", "-"],
        stdin: new Blob([content]),
        stdout: "pipe",
        stderr: "pipe",
    })
    const stderr = await new Response(proc.stderr).text()
    const code = await proc.exited
    if (code !== 0) {
        exitWith(`crontab - failed (exit ${code}):\n${stderr.trim()}`)
    }
}

// ---------- commands ----------

async function cmdInstall(
    intervalHours: number,
    basedir: string,
    keepDays: number,
): Promise<void> {
    if (intervalHours < 1 || intervalHours > 23) {
        exitWith(`--interval must be between 1 and 23 hours (got ${intervalHours})`)
    }
    if (keepDays < 1) {
        exitWith(`--keep-days must be at least 1 (got ${keepDays})`)
    }

    await mkdir(basedir, { recursive: true })

    const cronLine = buildCronLine({
        intervalHours,
        basedir,
        keepDays,
        bunPath: process.execPath,
        repoRoot: REPO_ROOT,
    })

    // Replace any previous entry (idempotent install).
    const existing = await readCrontab()
    const kept = existing.filter(line => !line.includes(CRON_MARKER))
    await writeCrontab([...kept, cronLine])

    console.log(green("✅ snapshot cron installed"))
    console.log(`   schedule:  every ${intervalHours}h (minute 0)`)
    console.log(`   output:    ${basedir}/<YYYY-MM-DD_HH-MM>`)
    console.log(`   retention: ${keepDays} day(s), pruned only after a successful export`)
    console.log(`   log:       ${join(basedir, LOG_FILE_NAME)}`)
    console.log(`   crontab:   ${cronLine}`)
}

async function cmdStop(): Promise<void> {
    const existing = await readCrontab()
    const kept = existing.filter(line => !line.includes(CRON_MARKER))
    if (kept.length === existing.length) {
        console.log("no snapshot cron entry found; nothing to remove")
        return
    }
    await writeCrontab(kept)
    console.log(green("✅ snapshot cron removed"))
}

async function pruneOldSnapshots(
    basedir: string,
    keepDays: number,
): Promise<void> {
    const cutoff = Date.now() - keepDays * MS_PER_DAY
    const entries = await readdir(basedir, { withFileTypes: true })
    for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const ts = snapshotDirTimestamp(entry.name)
        if (ts === null || ts >= cutoff) continue
        await rm(join(basedir, entry.name), { recursive: true, force: true })
        console.log(`pruned snapshot older than ${keepDays}d: ${entry.name}`)
    }
}

/** One cron cycle: export into a dated dir, then prune only on success. */
async function cmdRun(basedir: string, keepDays: number): Promise<void> {
    const outDir = join(basedir, timestampDirName(new Date()))
    console.log(`[${new Date().toISOString()}] snapshot export -> ${outDir}`)

    const proc = Bun.spawn({
        cmd: [process.execPath, EXPORT_SCRIPT, "--outdir", outDir],
        cwd: REPO_ROOT,
        stdout: "inherit",
        stderr: "inherit",
    })
    const code = await proc.exited
    if (code !== 0) {
        // No pruning on failure: a broken exporter must never eat old snapshots.
        exitWith(`snapshot export failed (exit ${code}); skipping prune`, code)
    }

    await pruneOldSnapshots(basedir, keepDays)
}

// ---------- entry point ----------

async function main(): Promise<void> {
    const { flags } = parseArgs(process.argv.slice(2))

    if (flags.stop && flags.run) {
        exitWith("pass only one of --stop / --run")
    }

    if (flags.stop) {
        return cmdStop()
    }

    const basedir =
        flags.basedir !== undefined && flags.basedir !== "true"
            ? resolve(flags.basedir)
            : DEFAULT_BASEDIR
    const keepDays = parseIntFlag(
        flags["keep-days"],
        DEFAULT_KEEP_DAYS,
        "--keep-days",
    )

    if (flags.run) {
        return cmdRun(basedir, keepDays)
    }

    const intervalHours = parseIntFlag(
        flags.interval,
        DEFAULT_INTERVAL_HOURS,
        "--interval",
    )
    return cmdInstall(intervalHours, basedir, keepDays)
}

if (import.meta.main) {
    main().catch(e =>
        exitWith(e instanceof Error ? e.stack ?? e.message : String(e)),
    )
}
