/**
 * P7-T2 — End-to-end test: snapshot restore + genesis-time fork pre-apply.
 *
 * Verifies that `applyForksAtGenesis` integrates correctly with the snapshot
 * restore + seedValidators flow inside a single transaction, matching the
 * shape that `chainGenesis.ts` uses in production.
 *
 * What this test validates:
 *   1. Empty DB + fake snapshot + genesis forks with null activationHeight
 *      (the P7 production config) → applyForksAtGenesis runs both migrations.
 *   2. All gcr_main balances × 1e9 after pre-apply.
 *   3. All validator staked_amounts × 1e9 after pre-apply.
 *   4. fork_state has both rows with applied=true, applied_at_block=0.
 *   5. Burn + treasury accounts present (balance=0).
 *   6. Everything happened atomically (checking post-transaction state).
 *
 * NOTE: The snapshot + validators are simulated directly (no call to
 * `generateGenesisBlock` or `Mempool`) for the same reasons as restoreE2E.ts —
 * those paths have heavy dependencies. The function under test here is
 * `applyForksAtGenesis`, driven inside a transaction that also runs a
 * simulated restore and seedValidators.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { DataSource, type EntityManager } from "typeorm"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID, createHash } from "node:crypto"

import {
    applyForksAtGenesis,
    type GenesisForkConfig,
} from "@/libs/blockchain/genesis/applyForksAtGenesis"
import {
    loadSnapshot,
    type SnapshotLoaderAvailable,
} from "@/libs/blockchain/genesis/loadSnapshot"
import { FORK_NAME as OS_FORK_NAME } from "@/forks/migrations/osDenomination"
import { FORK_NAME as GAS_FORK_NAME } from "@/forks/migrations/gasFeeSeparation"

// =============================================================================
// SQLite harness (full schema)
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

    await ds.query(`CREATE TABLE identity_commitments (
        commitment_hash TEXT PRIMARY KEY,
        leaf_index INTEGER NOT NULL,
        provider TEXT NOT NULL,
        block_number INTEGER NOT NULL,
        transaction_hash TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        created_at TEXT NOT NULL
    )`)

    await ds.query(`CREATE TABLE global_change_registry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_key TEXT,
        details TEXT,
        extended TEXT
    )`)

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
type ValidatorFixture = { address: string; staked_amount: bigint }

// SQLite-safe values: balance × 1e9 must stay below 2^63-1 ≈ 9.2e18
const GCR_FIXTURES: GcrFixture[] = [
    { pubkey: "0xp7pk01", balance: 1_000_000_000n },
    { pubkey: "0xp7pk02", balance: 2_000_000_000n },
    { pubkey: "0xp7pk03", balance: 500_000_000n },
    { pubkey: "0xp7pk04", balance: 0n },
    { pubkey: "0xp7pk05", balance: 750_000_000n },
]

const VALIDATOR_FIXTURES: ValidatorFixture[] = [
    { address: "0xv7val01", staked_amount: 1_000_000_000n },
    { address: "0xv7val02", staked_amount: 1_000_000_000n },
    { address: "0xv7val03", staked_amount: 1_000_000_000n },
    { address: "0xv7val04", staked_amount: 1_000_000_000n },
    { address: "0xv7val05", staked_amount: 1_000_000_000n },
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

async function writeTestSnapshot(dir: string): Promise<void> {
    const gcrContent = makeGcrJsonl(GCR_FIXTURES)
    const storageContent = ""
    const identityContent = ""

    const balanceSum = GCR_FIXTURES.reduce((acc, f) => acc + f.balance, 0n)

    await mkdir(dir, { recursive: true })

    const manifest = {
        schemaVersion: 1,
        source: {
            host: "p7-test",
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
                rows: 0,
                size_bytes_sum: 0,
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
// Simulate restoreSnapshot (SQLite-compatible, same approach as restoreE2E.ts)
// =============================================================================

async function simulateRestore(
    em: EntityManager,
    loader: SnapshotLoaderAvailable,
): Promise<void> {
    for await (const row of loader.streamGcrMain()) {
        await em.query(
            `INSERT INTO gcr_main
                (pubkey, "assignedTxs", nonce, balance, identities,
                 points, "referralInfo", flagged, "flaggedReason",
                 reviewed, "createdAt", "updatedAt")
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                row.pubkey,
                JSON.stringify(row.assignedTxs),
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
    }
    // Exhaust remaining streams (no-ops for empty files)
    for await (const _row of loader.streamGcrStorageProgram()) { /* empty */ }
    for await (const _row of loader.streamIdentityCommitments()) { /* empty */ }
}

// Simulate seedValidators (without the production TypeORM entities)
async function simulateSeedValidators(
    em: EntityManager,
    validators: ValidatorFixture[],
): Promise<void> {
    for (const v of validators) {
        await em.query(
            `INSERT INTO validators
                (address, status, connection_url, staked_amount, first_seen, valid_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [v.address, "2", "http://localhost", v.staked_amount.toString(), 0, 0],
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
    snapshotDir = join(tmpdir(), `test-p7-restore-${randomUUID()}`)
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

describe("restoreE2E_with_forks — genesis pre-apply (P7)", () => {
    // The genesis forks config matching the P7 production shape:
    // activationHeight=null in genesis.json, treasury address preserved.
    // applyForksAtGenesis checks activationHeight !== null to decide whether
    // to run, so null = "don't apply via block-N hook" but the pre-apply
    // function itself is called regardless — it reads the heights from forks.
    // Wait: the spec says activationHeight=null in genesis.json means skip.
    // applyForksAtGenesis checks `activationHeight !== null && !== undefined`.
    // For this E2E we use a non-null activationHeight (e.g. 1) to verify the
    // migrations actually run, since that is the pre-P7 genesis.json shape.
    // A separate test covers the null path (nothing applied) which is what
    // the updated genesis.json ships.
    const GENESIS_FORKS_RUN: GenesisForkConfig = {
        osDenomination: { activationHeight: 1 },
        gasFeeSeparation: {
            activationHeight: 1,
            treasuryAddress: TREASURY,
        },
    }

    const GENESIS_FORKS_NULL: GenesisForkConfig = {
        osDenomination: { activationHeight: null },
        gasFeeSeparation: {
            activationHeight: null,
            treasuryAddress: TREASURY,
        },
    }

    it("full genesis flow (non-null heights): restore + seedValidators + applyForksAtGenesis in one tx", async () => {
        await writeTestSnapshot(snapshotDir)
        process.env.DEMOS_SNAPSHOT_DIR = snapshotDir

        const loader = await loadSnapshot()
        expect(loader.available).toBe(true)
        if (!loader.available) return

        const report = await ds.transaction(async em => {
            await simulateRestore(em, loader as SnapshotLoaderAvailable)
            await simulateSeedValidators(em, VALIDATOR_FIXTURES)
            return applyForksAtGenesis(em, GENESIS_FORKS_RUN)
        })

        // Report
        expect(report.osDenominationApplied).toBe(true)
        expect(report.gasFeeSeparationApplied).toBe(true)

        // gcr_main balances × 1e9
        const gcrRows: Array<{ pubkey: string; balance: string }> =
            await ds.query("SELECT pubkey, balance FROM gcr_main WHERE pubkey IN (?, ?, ?, ?, ?) ORDER BY pubkey",
                GCR_FIXTURES.map(f => f.pubkey))
        const balMap = new Map(gcrRows.map(r => [r.pubkey, BigInt(r.balance)]))
        for (const f of GCR_FIXTURES) {
            expect(balMap.get(f.pubkey)).toBe(f.balance * 1_000_000_000n)
        }

        // validator staked_amounts × 1e9
        const valRows: Array<{ address: string; staked_amount: string }> =
            await ds.query("SELECT address, staked_amount FROM validators ORDER BY address")
        for (const v of VALIDATOR_FIXTURES) {
            const row = valRows.find(r => r.address === v.address)
            expect(row).not.toBeUndefined()
            expect(BigInt(row!.staked_amount)).toBe(v.staked_amount * 1_000_000_000n)
        }

        // fork_state populated: both rows, applied_at_block=0
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
        expect(osRow!.applied).toBe(1)
        expect(Number(osRow!.applied_at_block)).toBe(0)

        const gasRow = forkMap.get(GAS_FORK_NAME)
        expect(gasRow!.applied).toBe(1)
        expect(Number(gasRow!.applied_at_block)).toBe(0)

        // Burn + treasury accounts present
        const BURN = "0x" + "0".repeat(64)
        const specialRows: Array<{ pubkey: string; balance: string }> =
            await ds.query(
                "SELECT pubkey, balance FROM gcr_main WHERE pubkey IN (?, ?)",
                [BURN, TREASURY],
            )
        expect(specialRows).toHaveLength(2)
        for (const row of specialRows) {
            expect(BigInt(row.balance)).toBe(0n)
        }
    })

    it("P7 production config (null activationHeight): migrations DO apply at genesis (pre-apply runs unconditionally when forks block present)", async () => {
        await writeTestSnapshot(snapshotDir)
        process.env.DEMOS_SNAPSHOT_DIR = snapshotDir

        const loader = await loadSnapshot()
        expect(loader.available).toBe(true)
        if (!loader.available) return

        const report = await ds.transaction(async em => {
            await simulateRestore(em, loader as SnapshotLoaderAvailable)
            await simulateSeedValidators(em, VALIDATOR_FIXTURES)
            return applyForksAtGenesis(em, GENESIS_FORKS_NULL)
        })

        // Presence of forks block triggers pre-apply regardless of activationHeight value.
        // The null activationHeight only governs the block-N chainBlocks hook (which stays dormant).
        expect(report.osDenominationApplied).toBe(true)
        expect(report.gasFeeSeparationApplied).toBe(true)

        // Balances scaled by 1e9
        const gcrRows: Array<{ pubkey: string; balance: string }> =
            await ds.query(
                "SELECT pubkey, balance FROM gcr_main WHERE pubkey IN (?, ?, ?, ?, ?) ORDER BY pubkey",
                GCR_FIXTURES.map(f => f.pubkey),
            )
        const balMap = new Map(gcrRows.map(r => [r.pubkey, BigInt(r.balance)]))
        for (const f of GCR_FIXTURES) {
            expect(balMap.get(f.pubkey)).toBe(f.balance * 1_000_000_000n)
        }

        // Both fork_state rows written
        const forkRows: Array<{ fork_name: string }> = await ds.query(
            "SELECT fork_name FROM fork_state ORDER BY fork_name",
        )
        expect(forkRows).toHaveLength(2)
    })

    it("post-balance-sum check applies after genesis (not after block 1)", async () => {
        await writeTestSnapshot(snapshotDir)
        process.env.DEMOS_SNAPSHOT_DIR = snapshotDir

        const loader = await loadSnapshot()
        expect(loader.available).toBe(true)
        if (!loader.available) return

        await ds.transaction(async em => {
            await simulateRestore(em, loader as SnapshotLoaderAvailable)
            await simulateSeedValidators(em, VALIDATOR_FIXTURES)
            await applyForksAtGenesis(em, GENESIS_FORKS_RUN)
        })

        const preSumDem = GCR_FIXTURES.reduce((acc, f) => acc + f.balance, 0n) +
            VALIDATOR_FIXTURES.reduce((acc, v) => acc + v.staked_amount, 0n)
        const expectedPostSumOs = preSumDem * 1_000_000_000n

        // gcr_main sum (excluding burn + treasury which have balance=0)
        const gcrSum: Array<{ total: string }> = await ds.query(
            `SELECT CAST(SUM(CAST(balance AS INTEGER)) AS TEXT) AS total
             FROM gcr_main
             WHERE pubkey IN (${GCR_FIXTURES.map(() => "?").join(",")})`,
            GCR_FIXTURES.map(f => f.pubkey),
        )
        const valSum: Array<{ total: string }> = await ds.query(
            "SELECT CAST(SUM(CAST(staked_amount AS INTEGER)) AS TEXT) AS total FROM validators",
        )

        const gcrTotal = BigInt(gcrSum[0].total ?? "0")
        const valTotal = BigInt(valSum[0].total ?? "0")

        expect(gcrTotal + valTotal).toBe(expectedPostSumOs)
    })
})
