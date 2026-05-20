/**
 * Dry-run snapshot restore (P1-T5).
 *
 * Manual sanity check that exercises `restoreSnapshot()` end-to-end
 * against a freshly-wiped local Postgres, WITHOUT going through the full
 * genesis-block creation flow. The operator runs this directly:
 *
 *   ./run -b true            # wipe PG + data_* volumes
 *   bun snapshot:dry-run     # populate gcr_main + gcr_storageprogram from snapshot
 *
 * Asserts:
 *   1. The snapshot is verifiable (sha256 / row counts / sums all match).
 *   2. `restoreSnapshot()` inserts exactly the expected row counts.
 *   3. The post-restore balance sum in the live DB equals the manifest
 *      `balance_sum` (15024999999998868586 for the v1 snapshot).
 *
 * This is NOT part of CI. It is operator-driven against a wiped PG.
 */

import Datasource from "../../src/model/datasource"
import {
    loadSnapshot,
    type SnapshotLoaderAvailable,
} from "../../src/libs/blockchain/genesis/loadSnapshot"
import { restoreSnapshot } from "../../src/libs/blockchain/genesis/restoreSnapshot"

const EXPECTED_GCR_MAIN_ROWS = 13880
const EXPECTED_STORAGE_ROWS = 1382
const EXPECTED_IDENTITY_ROWS = 0
const EXPECTED_BALANCE_SUM = 15024999999998868586n

async function main(): Promise<void> {
    const t0 = Date.now()
    console.log("[dry-run] resolving snapshot")

    const loader = await loadSnapshot()
    if (!loader.available) {
        throw new Error(
            "no snapshot available at data/snapshot/ (set DEMOS_SNAPSHOT_DIR or run snapshot:transform first)",
        )
    }
    const available = loader as SnapshotLoaderAvailable
    const manifest = available.getSnapshotManifest()
    console.log(
        `[dry-run] snapshot OK: gcr_main=${manifest.files["gcr_main.jsonl"].rows} balance_sum=${manifest.files["gcr_main.jsonl"].balance_sum}`,
    )

    console.log("[dry-run] initializing dataSource")
    const db = await Datasource.getInstance()
    const dataSource = db.getDataSource()

    try {
        const t1 = Date.now()
        const result = await dataSource.transaction(async em => {
            return restoreSnapshot(em, available)
        })
        const t2 = Date.now()

        console.log("[dry-run] inserted row counts:", result)

        if (result.gcrMain !== EXPECTED_GCR_MAIN_ROWS) {
            throw new Error(
                `gcr_main row mismatch: ${result.gcrMain} != ${EXPECTED_GCR_MAIN_ROWS}`,
            )
        }
        if (result.gcrStorageProgram !== EXPECTED_STORAGE_ROWS) {
            throw new Error(
                `gcr_storageprogram row mismatch: ${result.gcrStorageProgram} != ${EXPECTED_STORAGE_ROWS}`,
            )
        }
        if (result.identityCommitments !== EXPECTED_IDENTITY_ROWS) {
            throw new Error(
                `identity_commitments row mismatch: ${result.identityCommitments} != ${EXPECTED_IDENTITY_ROWS}`,
            )
        }

        const sumRows: Array<{ sum: string | null }> = await dataSource.query(
            "SELECT COALESCE(SUM(balance), 0)::text AS sum FROM gcr_main",
        )
        const liveSum = BigInt(sumRows[0]?.sum ?? "0")
        if (liveSum !== EXPECTED_BALANCE_SUM) {
            throw new Error(
                `live balance_sum mismatch: ${liveSum} != ${EXPECTED_BALANCE_SUM}`,
            )
        }
        console.log(
            `[dry-run] live balance_sum OK: ${liveSum.toString()}`,
        )

        console.log(
            `[dry-run] timing: verify+init=${t1 - t0}ms, restore=${t2 - t1}ms, total=${Date.now() - t0}ms`,
        )
        console.log("[dry-run] PASS")
    } finally {
        await dataSource.destroy()
    }
}

main()
    .then(() => {
        process.exit(0)
    })
    .catch(err => {
        console.error("[dry-run] FAIL:", err instanceof Error ? err.message : err)
        if (err instanceof Error && err.stack) console.error(err.stack)
        process.exit(1)
    })
