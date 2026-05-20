/**
 * P4-T3 — Integration test for snapshot-driven genesis builder.
 *
 * Validates that `restoreSnapshot()` correctly populates gcr_main,
 * gcr_storageprogram, and identity_commitments from a fake 5-row
 * snapshot fixture, and that the pre-flight check rejects a non-empty DB.
 *
 * Requires a live Postgres instance. If no Postgres is available the
 * describe block skips gracefully (a `beforeAll` probe detects the
 * connection and marks tests as skipped).
 *
 * Test isolation: each test creates a fresh DataSource and truncates all
 * three tables inside its own transaction. Tables are truncated (not
 * dropped) so the PG schema stays intact for the full suite.
 *
 * NOTE: This test does NOT invoke `generateGenesisBlock` because that
 * function has heavy dependencies (Mempool, Chain, insert block, etc.).
 * Instead it drives `restoreSnapshot(em, loader)` directly — which IS the
 * function under test for P4-T3.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test"
import { DataSource } from "typeorm"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID, createHash } from "node:crypto"

import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { GCRStorageProgram } from "@/model/entities/GCRv2/GCR_StorageProgram"
import { IdentityCommitment } from "@/model/entities/GCRv2/IdentityCommitment"

import { restoreSnapshot, type RestoreReport } from "@/libs/blockchain/genesis/restoreSnapshot"
import { loadSnapshot, type SnapshotLoaderAvailable } from "@/libs/blockchain/genesis/loadSnapshot"

// =============================================================================
// Postgres connection
// =============================================================================

const PG_HOST = process.env.PG_HOST ?? "localhost"
const PG_PORT = Number(process.env.PG_PORT ?? "5432")
const PG_USER = process.env.PG_USER ?? "demosuser"
const PG_PASSWORD = process.env.PG_PASSWORD ?? "demospassword"
const PG_DATABASE = process.env.PG_DATABASE ?? "demos"

let ds: DataSource
let pgAvailable = false

async function createDs(): Promise<DataSource> {
    const source = new DataSource({
        type: "postgres",
        host: PG_HOST,
        port: PG_PORT,
        username: PG_USER,
        password: PG_PASSWORD,
        database: PG_DATABASE,
        synchronize: false,
        logging: false,
        entities: [GCRMain, GCRStorageProgram, IdentityCommitment],
    })
    await source.initialize()
    return source
}

// =============================================================================
// Snapshot fixture helpers
// =============================================================================

type GcrSeed = {
    pubkey: string
    balance: string
    flaggedReason?: string
}

function makeGcrMainJsonl(seeds: GcrSeed[]): string {
    return seeds
        .map(s =>
            JSON.stringify({
                pubkey: s.pubkey,
                assignedTxs: [],
                nonce: 0,
                balance: s.balance,
                identities: {},
                points: {},
                referralInfo: {},
                flagged: false,
                flaggedReason: s.flaggedReason ?? "",
                reviewed: false,
                createdAt: "2025-08-04 11:10:47.903",
                updatedAt: "2025-08-04 11:10:47.903",
            }),
        )
        .join("\n") + (seeds.length > 0 ? "\n" : "")
}

type StorageSeed = {
    storageAddress: string
    sizeBytes: number
}

function makeStorageJsonl(seeds: StorageSeed[]): string {
    return seeds
        .map(s =>
            JSON.stringify({
                storageAddress: s.storageAddress,
                owner: "0xowner",
                programName: "prog",
                encoding: "json",
                data: { key: "v" },
                sizeBytes: s.sizeBytes,
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
        .join("\n") + (seeds.length > 0 ? "\n" : "")
}

function sha256(content: string): string {
    return createHash("sha256").update(content).digest("hex")
}

async function writeTestSnapshot(
    dir: string,
    gcrSeeds: GcrSeed[],
    storageSeeds: StorageSeed[],
): Promise<void> {
    await mkdir(dir, { recursive: true })

    const gcrContent = makeGcrMainJsonl(gcrSeeds)
    const storageContent = makeStorageJsonl(storageSeeds)
    const identityContent = ""

    const balanceSum = gcrSeeds.reduce(
        (acc, s) => acc + BigInt(s.balance),
        0n,
    )
    const sizeBytesSum = storageSeeds.reduce((acc, s) => acc + s.sizeBytes, 0)

    const manifest = {
        schemaVersion: 1,
        source: {
            host: "test",
            chain_block_height: 0,
            chain_block_hash: "0x00",
            node_version: "test",
            pg_version: "17.0",
            dumped_at: "2026-01-01T00:00:00Z",
        },
        files: {
            "gcr_main.jsonl": {
                sha256: sha256(gcrContent),
                rows: gcrSeeds.length,
                balance_sum: balanceSum.toString(),
            },
            "gcr_storageprogram.jsonl": {
                sha256: sha256(storageContent),
                rows: storageSeeds.length,
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
// Fixture data
// =============================================================================

const GCR_SEEDS: GcrSeed[] = [
    { pubkey: "0xpubkey01", balance: "1000000000000000000" },
    { pubkey: "0xpubkey02", balance: "2000000000000000000" },
    { pubkey: "0xpubkey03", balance: "500000000000000000" },
    { pubkey: "0xpubkey04", balance: "0" },
    { pubkey: "0xpubkey05", balance: "9999999999998868586" },
]

const STORAGE_SEEDS: StorageSeed[] = [
    { storageAddress: "stor-test-001", sizeBytes: 120 },
    { storageAddress: "stor-test-002", sizeBytes: 380 },
]

const EXPECTED_BALANCE_SUM =
    GCR_SEEDS.reduce((acc, s) => acc + BigInt(s.balance), 0n)

// =============================================================================
// Test setup
// =============================================================================

let snapshotDir: string
let prevSnapshotEnv: string | undefined

beforeAll(async () => {
    try {
        ds = await createDs()
        pgAvailable = true
    } catch {
        pgAvailable = false
        console.warn(
            "[genesisRestore.test] Postgres not reachable — all tests will skip.",
        )
    }
})

afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy()
})

afterEach(async () => {
    // Restore env
    if (prevSnapshotEnv === undefined) {
        delete process.env.DEMOS_SNAPSHOT_DIR
    } else {
        process.env.DEMOS_SNAPSHOT_DIR = prevSnapshotEnv
    }

    // Cleanup temp dir
    if (snapshotDir) {
        await rm(snapshotDir, { recursive: true, force: true })
    }

    // Truncate tables to leave DB clean for next test
    if (pgAvailable && ds?.isInitialized) {
        await ds.query(`TRUNCATE TABLE gcr_main, gcr_storageprogram, identity_commitments CASCADE`)
    }
})

// =============================================================================
// Tests
// =============================================================================

describe("genesisRestore integration (requires Postgres)", () => {
    it.skipIf(!pgAvailable)(
        "5-row gcr_main + 2-row gcr_storageprogram + 0-row identity → all rows inserted",
        async () => {
            snapshotDir = join(tmpdir(), `test-genesis-restore-${randomUUID()}`)
            prevSnapshotEnv = process.env.DEMOS_SNAPSHOT_DIR
            process.env.DEMOS_SNAPSHOT_DIR = snapshotDir

            await writeTestSnapshot(snapshotDir, GCR_SEEDS, STORAGE_SEEDS)

            const loader = await loadSnapshot()
            expect(loader.available).toBe(true)
            if (!loader.available) return

            let report: RestoreReport | null = null
            await ds.transaction(async em => {
                report = await restoreSnapshot(em, loader as SnapshotLoaderAvailable)
            })

            expect(report).not.toBeNull()
            expect(report!.gcrMain).toBe(5)
            expect(report!.gcrStorageProgram).toBe(2)
            expect(report!.identityCommitments).toBe(0)

            // Verify DB state via raw queries
            const gcrCount = await ds.query(
                "SELECT COUNT(*) AS cnt FROM gcr_main",
            )
            expect(Number(gcrCount[0].cnt)).toBe(5)

            const storageCount = await ds.query(
                "SELECT COUNT(*) AS cnt FROM gcr_storageprogram",
            )
            expect(Number(storageCount[0].cnt)).toBe(2)

            const identityCount = await ds.query(
                "SELECT COUNT(*) AS cnt FROM identity_commitments",
            )
            expect(Number(identityCount[0].cnt)).toBe(0)
        },
    )

    it.skipIf(!pgAvailable)(
        "rows match snapshot exactly: nonce=0, assignedTxs=[], correct balance",
        async () => {
            snapshotDir = join(tmpdir(), `test-genesis-restore-${randomUUID()}`)
            prevSnapshotEnv = process.env.DEMOS_SNAPSHOT_DIR
            process.env.DEMOS_SNAPSHOT_DIR = snapshotDir

            await writeTestSnapshot(snapshotDir, GCR_SEEDS, STORAGE_SEEDS)

            const loader = await loadSnapshot()
            expect(loader.available).toBe(true)
            if (!loader.available) return

            await ds.transaction(async em => {
                await restoreSnapshot(em, loader as SnapshotLoaderAvailable)
            })

            // Check a specific row
            const rows: Array<{ pubkey: string; nonce: string; balance: string }> =
                await ds.query(
                    "SELECT pubkey, nonce, balance::text FROM gcr_main WHERE pubkey = $1",
                    [GCR_SEEDS[0].pubkey],
                )
            expect(rows).toHaveLength(1)
            expect(rows[0].nonce).toBe("0")
            expect(rows[0].balance).toBe(GCR_SEEDS[0].balance)

            // Check balance sum
            const sumRows: Array<{ total: string }> = await ds.query(
                "SELECT SUM(balance::numeric)::text AS total FROM gcr_main",
            )
            expect(BigInt(sumRows[0].total)).toBe(EXPECTED_BALANCE_SUM)
        },
    )

    it.skipIf(!pgAvailable)(
        "idempotency/non-empty rejection: stale gcr_main row → throws with expected message",
        async () => {
            snapshotDir = join(tmpdir(), `test-genesis-restore-${randomUUID()}`)
            prevSnapshotEnv = process.env.DEMOS_SNAPSHOT_DIR
            process.env.DEMOS_SNAPSHOT_DIR = snapshotDir

            await writeTestSnapshot(snapshotDir, GCR_SEEDS, STORAGE_SEEDS)

            // Insert one stale row into gcr_main before calling restoreSnapshot
            await ds.query(
                `INSERT INTO gcr_main
                    (pubkey, "assignedTxs", nonce, balance, identities, points,
                     "referralInfo", flagged, "flaggedReason", reviewed, "createdAt", "updatedAt")
                 VALUES
                    ($1, $2::jsonb, 0, 0, $3::jsonb, $4::jsonb, $5::jsonb, false, '', false, NOW(), NOW())`,
                [
                    "0xstale",
                    JSON.stringify([]),
                    JSON.stringify({}),
                    JSON.stringify({}),
                    JSON.stringify({}),
                ],
            )

            const loader = await loadSnapshot()
            expect(loader.available).toBe(true)
            if (!loader.available) return

            await expect(
                ds.transaction(async em => {
                    await restoreSnapshot(em, loader as SnapshotLoaderAvailable)
                }),
            ).rejects.toThrow(/snapshot restore requires empty database/i)
        },
    )

    it("no-snapshot back-compat: DEMOS_SNAPSHOT_DIR unset → loadSnapshot returns available:false", async () => {
        // This tests the fall-through path — no DB required.
        prevSnapshotEnv = process.env.DEMOS_SNAPSHOT_DIR
        const nonExistentDir = join(tmpdir(), `no-such-${randomUUID()}`)
        process.env.DEMOS_SNAPSHOT_DIR = nonExistentDir

        const result = await loadSnapshot()
        expect(result.available).toBe(false)
    })
})
