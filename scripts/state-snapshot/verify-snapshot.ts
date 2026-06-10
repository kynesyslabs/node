/**
 * State Snapshot Verifier CLI (P0-T2).
 *
 * Re-validates `data/snapshot/manifest.json` against the on-disk JSONL
 * files. Fails loud on any mismatch. The core verify logic now lives in
 * `src/libs/blockchain/genesis/verifySnapshot.ts` so that the genesis
 * loader (P1) can share the same integrity gate without duplicating
 * code. This file remains the operator-facing CLI entry point and is
 * runnable via `bun scripts/state-snapshot/verify-snapshot.ts`.
 */

import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import {
    verifySnapshot,
    type SnapshotManifest,
} from "../../src/libs/blockchain/genesis/verifySnapshot"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, "..", "..")
const SNAPSHOT_DIR = resolve(REPO_ROOT, "data", "snapshot")

// Re-export the manifest type so any pre-existing importers (none in tree
// as of P1, but be friendly) keep working without churn.
export type { SnapshotManifest } from "../../src/libs/blockchain/genesis/verifySnapshot"

/**
 * Convenience wrapper that targets the repo's default snapshot dir. Used
 * by callers that don't want to compute the path themselves.
 */
export async function verifyDefaultSnapshot(): Promise<SnapshotManifest> {
    return verifySnapshot(SNAPSHOT_DIR)
}

async function runCli(): Promise<void> {
    const manifest = await verifySnapshot(SNAPSHOT_DIR)
    const m = manifest.files
    const validators = m["validators.jsonl"]
        ? ` validators=${m["validators.jsonl"].rows}`
        : ""
    const forks = manifest.fork_state
        ? ` fork_state=${manifest.fork_state.length}` +
          (manifest.fork_state.some(f => f.applied)
              ? `(applied: ${manifest.fork_state
                    .filter(f => f.applied)
                    .map(f => f.fork_name)
                    .join(",")})`
              : "")
        : ""
    console.log(
        `verify OK (v${manifest.schemaVersion}): gcr_main=${m["gcr_main.jsonl"].rows} balance_sum=${m["gcr_main.jsonl"].balance_sum} storage=${m["gcr_storageprogram.jsonl"].rows} size_bytes_sum=${m["gcr_storageprogram.jsonl"].size_bytes_sum} identity=${m["identity_commitments.jsonl"].rows}${validators}${forks}`,
    )
}

// Run when invoked directly (not when imported).
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ""
if (invokedPath === __filename) {
    runCli().catch((err) => {
        console.error(
            "verify failed:",
            err instanceof Error ? err.message : err,
        )
        process.exit(1)
    })
}
