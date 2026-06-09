/**
 * P4-T5 — End-to-end test for snapshot restore + fork activation.
 *
 * This test verifies the full "snapshot → genesis restore → fork activation"
 * pipeline as comprehensively as possible without requiring a live Postgres
 * connection or a running Mempool.
 *
 * Scope:
 *   1. Write a fake 5-row snapshot to a temp dir.
 *   2. `loadSnapshot()` — verifies snapshot integrity.
 *   3. Simulate the genesis restore by streaming rows and inserting them
 *      into a SQLite DataSource (mirrors what `restoreSnapshot` does in
 *      production against Postgres).
 *   4. Run `osDenomination` and `gasFeeSeparation` migrations.
 *   5. Assert end-state:
 *      - 5 gcr_main rows present
 *      - balances post-fork = original × 1e9
 *      - fork_state for both forks `applied=true, applied_at_block=1`
 *
 * SKIPPED: The `insertBlock` path that normally wraps the fork hook
 * is too tightly coupled to `Datasource.getInstance()`, `Mempool`, and
 * block-hash machinery to exercise in a unit/integration context without
 * a full running node. The fork activation logic itself is exercised here
 * by calling the migration functions directly — the same path that
 * `insertBlock` takes internally (via the `transactionalEntityManager`
 * passed into the fork hooks).
 *
 * See also: forkAfterRestore.test.ts for focused migration-layer tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { DataSource, type EntityManager } from "typeorm"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID, createHash } from "node:crypto"

import {
    runOsDenominationMigration,
    FORK_NAME as OS_FORK_NAME,
} from "@/forks/migrations/osDenomination"
import {
    runGasFeeSeparationMigration,
    FORK_NAME as GAS_FORK_NAME,
} from "@/forks/migrations/gasFeeSeparation"
import { loadSnapshot, type SnapshotLoaderAvailable } from "@/libs/blockchain/genesis/loadSnapshot"

// =============================================================================
// SQLite harness (full schema for end-to-end state verification)
// =============================================================================

async function createE2EDataSource(): Promise<DataSource> {
    const ds = new DataSource({
        type: "sqlite",
        database: ":memory:",
        synchronize: false,
        logging: false,
        entities: [],
    })
    await ds.initialize()

    // gcr_main (matches real Postgres: NO assignedTxs — moved to
    // gcr_assigned_txs by MoveAssignedTxsToOwnTable)
    await ds.query(`CREATE TABLE gcr_main (
        pubkey TEXT PRIMARY KEY,
        nonce INTEGER NOT NULL DEFAULT 0,
        balance BIGINT NOT NULL DEFAULT 0,
        identities TEXT NOT NULL DEFAULT '{}',
        points TEXT NOT NULL DEFAULT '{}',
        "referralInfo" TEXT NOT NULL DEFAULT '{}',
        flagged INTEGER NOT NULL DEFAULT 0,
        "flaggedReason" TEXT NOT NULL DEFAULT '',
        reviewed INTEGER NOT NULL DEFAULT 0,
        "createdAt" TEXT NOT NULL,
        "updatedAt" TEXT NOT NULL
    )`)

    // gcr_storageprogram (minimal columns for the E2E)
    await ds.query(`CREATE TABLE gcr_storageprogram (
        "storageAddress" TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        "programName" TEXT NOT NULL,
        encoding TEXT NOT NULL,
        data TEXT,
        "sizeBytes" INTEGER NOT NULL DEFAULT 0,
        acl TEXT NOT NULL DEFAULT '{}',
        metadata TEXT,
        "storageLocation" TEXT NOT NULL,
        "ipfsCid" TEXT,
        salt TEXT,
        "createdByTx" TEXT NOT NULL,
        "lastModifiedByTx" TEXT NOT NULL,
        "totalFeesPaid" TEXT NOT NULL DEFAULT '0',
        "isDeleted" INTEGER NOT NULL DEFAULT 0,
        "interactionTxs" TEXT NOT NULL DEFAULT '',
        "deletedByTx" TEXT,
        "createdAt" TEXT NOT NULL,
        "updatedAt" TEXT NOT NULL
    )`)

    // identity_commitments (minimal)
    await ds.query(`CREATE TABLE identity_commitments (
        commitment_hash TEXT PRIMARY KEY,
        leaf_index INTEGER NOT NULL,
        provider TEXT NOT NULL,
        block_number INTEGER NOT NULL,
        transaction_hash TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        created_at TEXT NOT NULL
    )`)

    // global_change_registry — required by osDenomination
    await ds.query(`CREATE TABLE global_change_registry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_key TEXT,
        details TEXT,
        extended TEXT
    )`)

    // validators — required by osDenomination
    await ds.query(`CREATE TABLE validators (
        address TEXT PRIMARY KEY,
        staked_amount TEXT
    )`)

    // fork_state — required by both migrations
    await ds.query(`CREATE TABLE fork_state (
        fork_name TEXT PRIMARY KEY,
        applied INTEGER NOT NULL DEFAULT 0,
        applied_at_block BIGINT,
        applied_at TEXT,
        pre_sum_dem TEXT,
        post_sum_os TEXT,
        gcr_v2_row_count INTEGER,
        legacy_row_count INTEGER,
        validators_row_count INTEGER,
        capped_count INTEGER,
        total_value_lost_os TEXT,
        malformed_validators_count INTEGER
    )`)

    return ds
}

// =============================================================================
// Snapshot fixture
// =============================================================================

type GcrFixture = { pubkey: string; balance: bigint }

// Balances chosen to stay within SQLite BIGINT arithmetic range after × 1e9.
const GCR_FIXTURES: GcrFixture[] = [
    { pubkey: "0xe2epk01", balance: 1_000_000_000n },
    { pubkey: "0xe2epk02", balance: 2_500_000_000n },
    { pubkey: "0xe2epk03", balance: 500_000_000n },
    { pubkey: "0xe2epk04", balance: 0n },
    { pubkey: "0xe2epk05", balance: 750_000_000n },
]

type StorageFixture = { storageAddress: string; sizeBytes: number }

const STORAGE_FIXTURES: StorageFixture[] = [
    { storageAddress: "stor-e2e-001", sizeBytes: 200 },
    { storageAddress: "stor-e2e-002", sizeBytes: 350 },
]

const TREASURY = "0x" + "cd".repeat(32)

function sha256(s: string): string {
    return createHash("sha256").update(s).digest("hex")
}

function makeGcrJsonl(fixtures: GcrFixture[]): string {
    return (
        fixtures
            .map(f =>
                JSON.stringify({
                    pubkey: f.pubkey,
                    assignedTxs: [],
                    nonce: 0,
                    balance: f.balance.toString(),
                    identities: {},
                    points: {},
                    referralInfo: {},
                    flagged: false,
                    flaggedReason: "",
                    reviewed: false,
                    createdAt: "2025-08-04 11:10:47.903",
                    updatedAt: "2025-08-04 11:10:47.903",
                }),
            )
            .join("\n") + "\n"
    )
}

function makeStorageJsonl(fixtures: StorageFixture[]): string {
    return (
        fixtures
            .map(f =>
                JSON.stringify({
                    storageAddress: f.storageAddress,
                    owner: "0xe2eowner",
                    programName: "e2e-prog",
                    encoding: "json",
                    data: { k: "v" },
                    sizeBytes: f.sizeBytes,
                    acl: { mode: "public" },
                    metadata: null,
                    storageLocation: "onchain",
                    ipfsCid: null,
                    salt: null,
                    createdByTx: "0xtx",
                    lastModifiedByTx: "0xtx",
                    totalFeesPaid: "1",
                    isDeleted: false,
                    interactionTxs: "0xtx",
                    deletedByTx: null,
                    createdAt: "2026-01-01 00:00:00",
                    updatedAt: "2026-01-01 00:00:00",
                }),
            )
            .join("\n") + "\n"
    )
}

async function writeE2ESnapshot(dir: string): Promise<void> {
    const gcrContent = makeGcrJsonl(GCR_FIXTURES)
    const storageContent = makeStorageJsonl(STORAGE_FIXTURES)
    const identityContent = ""

    const balanceSum = GCR_FIXTURES.reduce(
        (acc, f) => acc + f.balance,
        0n,
    )
    const sizeBytesSum = STORAGE_FIXTURES.reduce(
        (acc, f) => acc + f.sizeBytes,
        0,
    )

    await mkdir(dir, { recursive: true })

    const manifest = {
        schemaVersion: 1,
        source: {
            host: "e2e-test",
            chain_block_height: 0,
            chain_block_hash: "0x00",
            node_version: "test",
            pg_version: "17.0",
            dumped_at: "2026-01-01T00:00:00Z",
        },
        files: {
            "gcr_main.jsonl": {
                sha256: sha256(gcrContent),
                rows: GCR_FIXTURES.length,
                balance_sum: balanceSum.toString(),
            },
            "gcr_storageprogram.jsonl": {
                sha256: sha256(storageContent),
                rows: STORAGE_FIXTURES.length,
                size_bytes_sum: sizeBytesSum,
            },
            "identity_commitments.jsonl": {
                sha256: sha256(identityContent),
                rows: 0,
            },
        },
        transforms_applied: {
            nonces_reset_to_zero: true,
            assigned_txs_emptied: true,
            test_identity_commitments_dropped: 0,
        },
    }

    await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2))
    await writeFile(join(dir, "gcr_main.jsonl"), gcrContent)
    await writeFile(join(dir, "gcr_storageprogram.jsonl"), storageContent)
    await writeFile(join(dir, "identity_commitments.jsonl"), identityContent)
}

// =============================================================================
// Simulate what restoreSnapshot does (SQLite-compatible version)
// =============================================================================

/**
 * Loads the snapshot via `loadSnapshot()` and streams every row into the
 * SQLite DataSource using raw INSERT statements. This mirrors what the
 * production `restoreSnapshot` does with TypeORM entity bulk-insert.
 *
 * We use raw SQL here because the SQLite DataSource does not have entity
 * metadata for GCRMain / GCRStorageProgram / IdentityCommitment — those
 * entities target Postgres-specific column types (jsonb, numeric). The
 * raw SQL path is compatible with both backends.
 */
async function simulateRestore(
    em: EntityManager,
    loader: SnapshotLoaderAvailable,
): Promise<{ gcrMain: number; storage: number; identity: number }> {
    let gcrMain = 0
    let storage = 0
    let identity = 0

    for await (const row of loader.streamGcrMain()) {
        // assignedTxs dropped from the gcr_main insert (moved to
        // gcr_assigned_txs); mirrors the real restoreSnapshot.
        await em.query(
            `INSERT INTO gcr_main
                (pubkey, nonce, balance, identities,
                 points, "referralInfo", flagged, "flaggedReason",
                 reviewed, "createdAt", "updatedAt")
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                row.pubkey,
                row.nonce,
                row.balance.toString(),
                JSON.stringify(row.identities),
                JSON.stringify(row.points),
                JSON.stringify(row.referralInfo),
                row.flagged ? 1 : 0,
                row.flaggedReason,
                row.reviewed ? 1 : 0,
                row.createdAt.toISOString(),
                row.updatedAt.toISOString(),
            ],
        )
        gcrMain++
    }

    for await (const row of loader.streamGcrStorageProgram()) {
        await em.query(
            `INSERT INTO gcr_storageprogram
                ("storageAddress", owner, "programName", encoding, data,
                 "sizeBytes", acl, metadata, "storageLocation", "ipfsCid",
                 salt, "createdByTx", "lastModifiedByTx", "totalFeesPaid",
                 "isDeleted", "interactionTxs", "deletedByTx",
                 "createdAt", "updatedAt")
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                row.storageAddress,
                row.owner,
                row.programName,
                row.encoding,
                row.data !== null ? JSON.stringify(row.data) : null,
                row.sizeBytes,
                JSON.stringify(row.acl),
                row.metadata !== null ? JSON.stringify(row.metadata) : null,
                row.storageLocation,
                row.ipfsCid,
                row.salt,
                row.createdByTx,
                row.lastModifiedByTx,
                row.totalFeesPaid.toString(),
                row.isDeleted ? 1 : 0,
                row.interactionTxs.join(","),
                row.deletedByTx,
                row.createdAt.toISOString(),
                row.updatedAt.toISOString(),
            ],
        )
        storage++
    }

    for await (const _row of loader.streamIdentityCommitments()) {
        identity++
    }

    return { gcrMain, storage, identity }
}

// =============================================================================
// Test state
// =============================================================================

let ds: DataSource
let snapshotDir: string
let prevSnapshotEnv: string | undefined

beforeEach(async () => {
    ds = await createE2EDataSource()
    snapshotDir = join(tmpdir(), `test-e2e-restore-${randomUUID()}`)
    prevSnapshotEnv = process.env.DEMOS_SNAPSHOT_DIR
})

afterEach(async () => {
    if (ds?.isInitialized) await ds.destroy()
    await rm(snapshotDir, { recursive: true, force: true })
    if (prevSnapshotEnv === undefined) {
        delete process.env.DEMOS_SNAPSHOT_DIR
    } else {
        process.env.DEMOS_SNAPSHOT_DIR = prevSnapshotEnv
    }
})

// =============================================================================
// E2E test suite
// =============================================================================

describe("restoreE2E — full pipeline: snapshot load → insert → fork activation", () => {
    it("full pipeline: 5 gcr_main rows present after restore, balances correct", async () => {
        await writeE2ESnapshot(snapshotDir)
        process.env.DEMOS_SNAPSHOT_DIR = snapshotDir

        const loader = await loadSnapshot()
        expect(loader.available).toBe(true)
        if (!loader.available) return

        await ds.transaction(async em => {
            await simulateRestore(em, loader as SnapshotLoaderAvailable)
        })

        const rows: Array<{ pubkey: string; balance: string }> =
            await ds.query("SELECT pubkey, balance FROM gcr_main ORDER BY pubkey")
        expect(rows).toHaveLength(5)

        // Verify balances match fixture input
        const balMap = new Map(rows.map(r => [r.pubkey, BigInt(r.balance)]))
        for (const fixture of GCR_FIXTURES) {
            expect(balMap.get(fixture.pubkey)).toBe(fixture.balance)
        }
    })

    it("full pipeline: 2 gcr_storageprogram rows present after restore", async () => {
        await writeE2ESnapshot(snapshotDir)
        process.env.DEMOS_SNAPSHOT_DIR = snapshotDir

        const loader = await loadSnapshot()
        expect(loader.available).toBe(true)
        if (!loader.available) return

        await ds.transaction(async em => {
            await simulateRestore(em, loader as SnapshotLoaderAvailable)
        })

        const count: Array<{ cnt: number }> = await ds.query(
            "SELECT COUNT(*) AS cnt FROM gcr_storageprogram",
        )
        expect(Number(count[0].cnt)).toBe(2)
    })

    it("full pipeline: 0 identity_commitments rows (test row dropped in fixture)", async () => {
        await writeE2ESnapshot(snapshotDir)
        process.env.DEMOS_SNAPSHOT_DIR = snapshotDir

        const loader = await loadSnapshot()
        expect(loader.available).toBe(true)
        if (!loader.available) return

        const report = await ds.transaction(async em => {
            return simulateRestore(em, loader as SnapshotLoaderAvailable)
        })

        expect(report.identity).toBe(0)
        const count: Array<{ cnt: number }> = await ds.query(
            "SELECT COUNT(*) AS cnt FROM identity_commitments",
        )
        expect(Number(count[0].cnt)).toBe(0)
    })

    it("osDenomination: balances post-fork = original × 1e9", async () => {
        await writeE2ESnapshot(snapshotDir)
        process.env.DEMOS_SNAPSHOT_DIR = snapshotDir

        const loader = await loadSnapshot()
        expect(loader.available).toBe(true)
        if (!loader.available) return

        // Step 1: restore
        await ds.transaction(async em => {
            await simulateRestore(em, loader as SnapshotLoaderAvailable)
        })

        // Step 2: osDenomination migration
        await ds.transaction(em => runOsDenominationMigration(em, 1))

        // Verify all balances multiplied
        const rows: Array<{ pubkey: string; balance: string }> =
            await ds.query("SELECT pubkey, balance FROM gcr_main ORDER BY pubkey")
        const balMap = new Map(rows.map(r => [r.pubkey, BigInt(r.balance)]))

        for (const fixture of GCR_FIXTURES) {
            const expected = fixture.balance * 1_000_000_000n
            expect(balMap.get(fixture.pubkey)).toBe(expected)
        }
    })

    it("fork_state: both forks applied=true, applied_at_block=1 after full pipeline", async () => {
        await writeE2ESnapshot(snapshotDir)
        process.env.DEMOS_SNAPSHOT_DIR = snapshotDir

        const loader = await loadSnapshot()
        expect(loader.available).toBe(true)
        if (!loader.available) return

        // Step 1: restore
        await ds.transaction(async em => {
            await simulateRestore(em, loader as SnapshotLoaderAvailable)
        })

        // Step 2: both migrations at block 1
        await ds.transaction(em => runOsDenominationMigration(em, 1))
        await ds.transaction(em =>
            runGasFeeSeparationMigration(em, 1, TREASURY),
        )

        // Assert fork_state
        const forkRows: Array<{
            fork_name: string
            applied: number
            applied_at_block: string
        }> = await ds.query(
            "SELECT fork_name, applied, applied_at_block FROM fork_state ORDER BY fork_name",
        )

        expect(forkRows).toHaveLength(2)
        const forkMap = new Map(forkRows.map(r => [r.fork_name, r]))

        const osRow = forkMap.get(OS_FORK_NAME)
        expect(osRow).not.toBeUndefined()
        expect(osRow!.applied).toBe(1)
        expect(Number(osRow!.applied_at_block)).toBe(1)

        const gasRow = forkMap.get(GAS_FORK_NAME)
        expect(gasRow).not.toBeUndefined()
        expect(gasRow!.applied).toBe(1)
        expect(Number(gasRow!.applied_at_block)).toBe(1)
    })

    it("manifest integrity gate: tampered snapshot causes loadSnapshot to throw", async () => {
        await writeE2ESnapshot(snapshotDir)
        // Tamper the gcr_main file
        const gcrPath = join(snapshotDir, "gcr_main.jsonl")
        const original = await Bun.file(gcrPath).text()
        await writeFile(gcrPath, original + "corrupted")

        process.env.DEMOS_SNAPSHOT_DIR = snapshotDir

        // loadSnapshot calls verifySnapshot; tampered file → sha256 mismatch → throw
        await expect(loadSnapshot()).rejects.toThrow(/sha256 mismatch/)
    })
})
