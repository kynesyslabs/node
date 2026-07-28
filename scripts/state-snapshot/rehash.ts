/* eslint-disable no-console */
/**
 * Snapshot Manifest Rehasher.
 *
 * Recomputes the per-file integrity metadata in `data/snapshot/manifest.json`
 * (sha256 / rows / balance_sum / size_bytes_sum) from the JSONL files on
 * disk, using the same single-pass logic as the shared `verifySnapshot()`
 * integrity gate. Run it after intentionally editing a snapshot file (e.g.
 * validators.jsonl) so `snapshot:verify` and the genesis loader accept the
 * snapshot again.
 *
 * Only `manifest.files` is touched. Provenance sections (source, fork_state,
 * transforms_applied) are not derivable from the files and are preserved
 * verbatim — refreshing those requires a full re-export (snapshot:export).
 *
 * Finishes by re-running `verifySnapshot()` as a self-check, mirroring the
 * exporter.
 *
 * Usage:
 *   bun run snapshot:rehash [--check] [--outdir <dir>]
 *
 * Flags:
 *   --check          report what would change and exit 1 if anything differs,
 *                    without writing.
 *   --outdir <dir>   snapshot directory. Default data/snapshot.
 */

import { readFile, rename, stat, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { parseArgs, resolveOutDir } from "./export"
import {
    readFileSinglePass,
    verifySnapshot,
    type SnapshotFileEntry,
    type SnapshotManifest,
} from "../../src/libs/blockchain/genesis/verifySnapshot"

function exitWith(msg: string, code = 1): never {
    console.error(msg)
    process.exit(code)
}

type FileSpec = {
    name: string
    sumField?: "balance" | "sizeBytes"
}

const FILE_SPECS: FileSpec[] = [
    { name: "gcr_main.jsonl", sumField: "balance" },
    { name: "gcr_storageprogram.jsonl", sumField: "sizeBytes" },
    { name: "identity_commitments.jsonl" },
    { name: "validators.jsonl" },
]

const ENTRY_KEYS = ["sha256", "rows", "balance_sum", "size_bytes_sum"] as const

/** Read and validate the snapshot manifest, exiting on any problem. */
async function loadManifest(manifestPath: string): Promise<SnapshotManifest> {
    let manifestRaw: string
    try {
        manifestRaw = await readFile(manifestPath, "utf8")
    } catch (err) {
        exitWith(
            `cannot read manifest at ${manifestPath}: ${
                err instanceof Error ? err.message : String(err)
            }`,
        )
    }

    let manifest: SnapshotManifest
    try {
        manifest = JSON.parse(manifestRaw) as SnapshotManifest
    } catch (err) {
        exitWith(
            `${manifestPath} is not valid JSON: ${
                err instanceof Error ? err.message : String(err)
            }`,
        )
    }

    if (typeof manifest?.files !== "object" || manifest.files === null) {
        exitWith(
            `${manifestPath}: not a snapshot manifest (files section missing)`,
        )
    }

    return manifest
}

/** Recompute one snapshot file's entry from disk. */
async function computeEntry(
    snapshotDir: string,
    spec: FileSpec,
): Promise<SnapshotFileEntry> {
    const path = resolve(snapshotDir, spec.name)
    try {
        await stat(path)
    } catch {
        exitWith(`snapshot file missing: ${path}`)
    }

    const stats = await readFileSinglePass(path, spec.sumField)
    if (stats.parseError) {
        exitWith(`${stats.parseError.message} — manifest not written`)
    }

    const entry: SnapshotFileEntry = {
        sha256: stats.sha256,
        rows: stats.rows,
    }
    if (spec.sumField === "balance") {
        entry.balance_sum = (stats.balanceSum ?? 0n).toString()
    }
    if (spec.sumField === "sizeBytes") {
        entry.size_bytes_sum = stats.sizeBytesSum ?? 0
    }
    return entry
}

/**
 * Merge a freshly computed entry into the manifest, reporting what moved.
 *
 * @returns True if the manifest was modified for this file.
 */
function applyEntry(
    files: Record<string, SnapshotFileEntry | undefined>,
    name: string,
    entry: SnapshotFileEntry,
): boolean {
    const existing = files[name]
    if (existing === undefined) {
        files[name] = entry
        console.log(`${name}: added (rows=${entry.rows})`)
        return true
    }

    const diffs: string[] = []
    for (const key of ENTRY_KEYS) {
        if (entry[key] !== undefined && entry[key] !== existing[key]) {
            diffs.push(`${key}: ${existing[key]} -> ${entry[key]}`)
        }
    }
    if (diffs.length === 0) {
        console.log(`${name}: unchanged`)
        return false
    }

    files[name] = { ...existing, ...entry }
    console.log(`${name}: changed (${diffs.join(", ")})`)
    return true
}

async function main(): Promise<void> {
    const { flags } = parseArgs(process.argv.slice(2))
    const checkOnly = flags.check === "true"
    const snapshotDir = resolveOutDir(flags)
    const manifestPath = resolve(snapshotDir, "manifest.json")

    const manifest = await loadManifest(manifestPath)
    const files = manifest.files as Record<
        string,
        SnapshotFileEntry | undefined
    >

    const isV2 =
        typeof manifest.schemaVersion === "number" &&
        manifest.schemaVersion >= 2
    const changed: string[] = []

    for (const spec of FILE_SPECS) {
        if (spec.name === "validators.jsonl" && !isV2) continue

        const entry = await computeEntry(snapshotDir, spec)
        if (applyEntry(files, spec.name, entry)) {
            changed.push(spec.name)
        }
    }

    if (changed.length === 0) {
        console.log(`no changes: manifest already matches ${snapshotDir}`)
        return
    }

    if (checkOnly) {
        exitWith(
            `--check: ${changed.length} file(s) out of sync (${changed.join(", ")}), manifest not written`,
        )
    }

    // Write via a sibling temp file + rename so an interrupted or failed
    // write cannot truncate the live manifest and leave the snapshot
    // unloadable. Same directory keeps the rename atomic (same filesystem).
    const temporaryManifestPath = `${manifestPath}.tmp`
    await writeFile(
        temporaryManifestPath,
        JSON.stringify(manifest, null, 2) + "\n",
    )
    await rename(temporaryManifestPath, manifestPath)

    const verified = await verifySnapshot(snapshotDir)
    console.log(
        `rehash OK (v${verified.schemaVersion}): updated ${changed.join(", ")} — verify OK`,
    )
}

if (import.meta.main) {
    main().catch(err =>
        exitWith(err instanceof Error ? err.message : String(err)),
    )
}
