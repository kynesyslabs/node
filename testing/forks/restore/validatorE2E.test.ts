/**
 * P6-T2 — End-to-end test for genesis validator seeding.
 *
 * Verifies the full pipeline:
 *   1. Write a minimal fake snapshot to a temp dir.
 *   2. Seed 2 genesis validators via `seedValidators` in the same SQLite
 *      transaction used for the simulated snapshot restore.
 *   3. Assert both validator rows are present with correct fields.
 *   4. Run `osDenomination` migration.
 *   5. Assert `staked_amount` is multiplied by 10^9 for each validator.
 *
 * This test uses SQLite (in-memory) and does NOT require a live Postgres
 * instance, matching the approach used by `restoreE2E.test.ts`. The
 * `validators` table is created manually in the SQLite schema because the
 * TypeORM entity targets Postgres-specific types (text PRIMARY KEY vs
 * TypeORM SQLite fallbacks). Raw SQL insert matches what `seedValidators`
 * does internally via `em.insert(Validators, batch)`.
 *
 * NOTE: `seedValidators` calls `em.insert(Validators, batch)` which uses
 * TypeORM's entity metadata. Because the SQLite DataSource has no
 * registered entities we call the function indirectly: we replicate its
 * contract using raw SQL inserts in the E2E harness and only test the
 * validation + pre-flight logic via the real function (against a stubbed em).
 * The actual TypeORM em.insert path is covered by the PG-gated integration
 * tests in `seedValidators.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { DataSource, type EntityManager } from "typeorm"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID, createHash } from "node:crypto"

import {
    runOsDenominationMigration,
} from "@/forks/migrations/osDenomination"
import {
    seedValidators,
    type GenesisValidatorSeed,
} from "@/libs/blockchain/genesis/seedValidators"

// =============================================================================
// SQLite harness
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

    // Minimal gcr_main required by osDenomination migration.
    await ds.query(`CREATE TABLE gcr_main (
        pubkey TEXT PRIMARY KEY,
        "assignedTxs" TEXT NOT NULL DEFAULT '[]',
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

    // global_change_registry required by osDenomination.
    await ds.query(`CREATE TABLE global_change_registry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_key TEXT,
        details TEXT,
        extended TEXT
    )`)

    // validators — required by osDenomination and by the seeder pre-flight.
    await ds.query(`CREATE TABLE validators (
        address TEXT PRIMARY KEY,
        status TEXT,
        connection_url TEXT,
        staked_amount TEXT,
        first_seen INTEGER,
        valid_at INTEGER,
        unstake_requested_at INTEGER,
        unstake_available_at INTEGER
    )`)

    // fork_state required by osDenomination.
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
// Snapshot fixture helpers (minimal — 2-row gcr_main, 0-row others)
// =============================================================================

type GcrFixture = { pubkey: string; balance: bigint }

const GCR_FIXTURES: GcrFixture[] = [
    { pubkey: "0xv6e2pk01", balance: 1_000_000_000n },
    { pubkey: "0xv6e2pk02", balance: 2_000_000_000n },
]

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

async function writeMinimalSnapshot(dir: string): Promise<void> {
    const gcrContent = makeGcrJsonl(GCR_FIXTURES)
    const emptyContent = ""

    await mkdir(dir, { recursive: true })

    const manifest = {
        schemaVersion: 1,
        source: {
            host: "validator-e2e-test",
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
                balance_sum: GCR_FIXTURES.reduce(
                    (acc, f) => acc + f.balance,
                    0n,
                ).toString(),
            },
            "gcr_storageprogram.jsonl": {
                sha256: sha256(emptyContent),
                rows: 0,
                size_bytes_sum: 0,
            },
            "identity_commitments.jsonl": {
                sha256: sha256(emptyContent),
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
    await writeFile(join(dir, "gcr_storageprogram.jsonl"), emptyContent)
    await writeFile(join(dir, "identity_commitments.jsonl"), emptyContent)
}

// =============================================================================
// Fake genesis validators (2 for this E2E)
// =============================================================================

const GENESIS_VALIDATORS: GenesisValidatorSeed[] = [
    {
        address:
            "0x24c664d9ef529f798e979357c6a7a01088226eefe05cfdb77fb42841f771e156",
        status: "2",
        connection_url: "http://node3.demos.sh:53550",
        staked_amount: "1000000000000000000",
        first_seen: 0,
        valid_at: 0,
    },
    {
        address:
            "0xe887b1433a2e2e72447d2410b12c947f1d40567862cabf705409ecc495416f1d",
        status: "2",
        connection_url: "http://38.242.135.203:53550",
        staked_amount: "1000000000000000000",
        first_seen: 0,
        valid_at: 0,
    },
]

// =============================================================================
// SQLite-compatible validator seed: mirrors what seedValidators does but uses
// raw SQL because the SQLite DataSource has no registered Validators entity.
// =============================================================================

async function seedValidatorsSQLite(
    em: EntityManager,
    seeds: GenesisValidatorSeed[],
): Promise<void> {
    // Pre-flight mirrors the real seedValidators pre-flight.
    const rows: Array<{ count: number }> = await em.query(
        `SELECT COUNT(*) AS count FROM validators`,
    )
    if (Number(rows[0].count) !== 0) {
        throw new Error(
            "validator seed requires empty validators table",
        )
    }

    for (const v of seeds) {
        await em.query(
            `INSERT INTO validators
                (address, status, connection_url, staked_amount,
                 first_seen, valid_at, unstake_requested_at, unstake_available_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                v.address,
                v.status,
                v.connection_url,
                v.staked_amount,
                v.first_seen,
                v.valid_at,
                null,
                null,
            ],
        )
    }
}

// =============================================================================
// Simulate gcr_main restore (SQLite-compatible)
// =============================================================================

async function seedGcrMain(
    em: EntityManager,
    fixtures: GcrFixture[],
): Promise<void> {
    for (const f of fixtures) {
        await em.query(
            `INSERT INTO gcr_main
                (pubkey, "assignedTxs", nonce, balance, identities, points,
                 "referralInfo", flagged, "flaggedReason", reviewed,
                 "createdAt", "updatedAt")
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                f.pubkey,
                JSON.stringify([]),
                0,
                f.balance.toString(),
                JSON.stringify({}),
                JSON.stringify({}),
                JSON.stringify({}),
                0,
                "",
                0,
                "2025-08-04T11:10:47.903Z",
                "2025-08-04T11:10:47.903Z",
            ],
        )
    }
}

// =============================================================================
// Test state
// =============================================================================

let ds: DataSource
let snapshotDir: string
let prevSnapshotEnv: string | undefined

beforeEach(async () => {
    ds = await createE2EDataSource()
    snapshotDir = join(tmpdir(), `test-validator-e2e-${randomUUID()}`)
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
// E2E tests
// =============================================================================

describe("validatorE2E — genesis validator seed + fork activation", () => {
    it("2 validator rows present after seeding with correct fields", async () => {
        await writeMinimalSnapshot(snapshotDir)
        process.env.DEMOS_SNAPSHOT_DIR = snapshotDir

        // Simulate the restore + validator seed in one transaction.
        await ds.transaction(async em => {
            await seedGcrMain(em, GCR_FIXTURES)
            await seedValidatorsSQLite(em, GENESIS_VALIDATORS)
        })

        const rows: Array<{
            address: string
            status: string
            staked_amount: string
            first_seen: number
            valid_at: number
            connection_url: string
            unstake_requested_at: number | null
            unstake_available_at: number | null
        }> = await ds.query(
            `SELECT address, status, staked_amount, first_seen, valid_at,
                    connection_url, unstake_requested_at, unstake_available_at
             FROM validators ORDER BY address`,
        )

        expect(rows).toHaveLength(2)

        for (const row of rows) {
            expect(row.status).toBe("2")
            expect(row.staked_amount).toBe("1000000000000000000")
            expect(Number(row.first_seen)).toBe(0)
            expect(Number(row.valid_at)).toBe(0)
            expect(row.unstake_requested_at).toBeNull()
            expect(row.unstake_available_at).toBeNull()
        }

        // Verify addresses match what we seeded.
        const addresses = new Set(rows.map(r => r.address))
        for (const seed of GENESIS_VALIDATORS) {
            expect(addresses.has(seed.address)).toBe(true)
        }
    })

    it("connection_url preserved exactly after seeding", async () => {
        await writeMinimalSnapshot(snapshotDir)
        process.env.DEMOS_SNAPSHOT_DIR = snapshotDir

        await ds.transaction(async em => {
            await seedGcrMain(em, GCR_FIXTURES)
            await seedValidatorsSQLite(em, GENESIS_VALIDATORS)
        })

        const rows: Array<{ address: string; connection_url: string }> =
            await ds.query(
                `SELECT address, connection_url FROM validators ORDER BY address`,
            )

        const urlMap = new Map(rows.map(r => [r.address, r.connection_url]))
        for (const seed of GENESIS_VALIDATORS) {
            expect(urlMap.get(seed.address)).toBe(seed.connection_url)
        }
    })

    it("osDenomination: staked_amount multiplied by 1e9 after migration", async () => {
        await writeMinimalSnapshot(snapshotDir)
        process.env.DEMOS_SNAPSHOT_DIR = snapshotDir

        // Step 1: restore gcr_main + seed validators.
        await ds.transaction(async em => {
            await seedGcrMain(em, GCR_FIXTURES)
            await seedValidatorsSQLite(em, GENESIS_VALIDATORS)
        })

        // Step 2: run osDenomination migration.
        await ds.transaction(em => runOsDenominationMigration(em, 1))

        // Step 3: verify staked_amount for each validator = 1e18 × 1e9 = 1e27.
        const rows: Array<{ address: string; staked_amount: string }> =
            await ds.query(
                `SELECT address, staked_amount FROM validators ORDER BY address`,
            )

        expect(rows).toHaveLength(2)
        for (const row of rows) {
            // Original was 1e18; migration multiplies by 1e9 → 1e27.
            expect(BigInt(row.staked_amount)).toBe(
                1_000_000_000_000_000_000n * 1_000_000_000n,
            )
        }
    })

    it("transaction atomicity: validator insert rolls back if transaction throws", async () => {
        await writeMinimalSnapshot(snapshotDir)
        process.env.DEMOS_SNAPSHOT_DIR = snapshotDir

        await expect(
            ds.transaction(async em => {
                await seedGcrMain(em, GCR_FIXTURES)
                await seedValidatorsSQLite(em, GENESIS_VALIDATORS)
                // Force rollback after seeding.
                throw new Error("simulated failure after validator seed")
            }),
        ).rejects.toThrow("simulated failure after validator seed")

        // Both gcr_main and validators must be empty after rollback.
        const gcrCount: Array<{ count: number }> = await ds.query(
            `SELECT COUNT(*) AS count FROM gcr_main`,
        )
        expect(Number(gcrCount[0].count)).toBe(0)

        const valCount: Array<{ count: number }> = await ds.query(
            `SELECT COUNT(*) AS count FROM validators`,
        )
        expect(Number(valCount[0].count)).toBe(0)
    })

    it("pre-flight in SQLite harness: non-empty validators table rejects seed", async () => {
        await writeMinimalSnapshot(snapshotDir)
        process.env.DEMOS_SNAPSHOT_DIR = snapshotDir

        // Pre-insert one validator.
        await ds.query(
            `INSERT INTO validators
                (address, status, connection_url, staked_amount,
                 first_seen, valid_at, unstake_requested_at, unstake_available_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                "2",
                null,
                "1000000000000000000",
                0,
                0,
                null,
                null,
            ],
        )

        await expect(
            ds.transaction(async em => {
                await seedValidatorsSQLite(em, GENESIS_VALIDATORS)
            }),
        ).rejects.toThrow(/validator seed requires empty validators table/i)
    })

    it("real seedValidators validation: malformed address rejects before any DB call", async () => {
        // Verify that the real seedValidators throws on bad address even when
        // given a stub em (no DB needed — validation fires before the pre-flight query).
        const badSeeds: GenesisValidatorSeed[] = [
            {
                address: "not-hex",
                status: "2",
                connection_url: null,
                staked_amount: "1000000000000000000",
                first_seen: 0,
                valid_at: 0,
            },
        ]

        const stubEm = {} as unknown as import("typeorm").EntityManager
        await expect(seedValidators(stubEm, badSeeds)).rejects.toThrow(
            /address invalid/i,
        )
    })
})
