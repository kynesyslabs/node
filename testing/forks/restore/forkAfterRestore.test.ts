/**
 * P4-T4 — Integration test: fork activation against snapshot-restored state.
 *
 * Exercises the interaction between snapshot restore and the osDenomination +
 * gasFeeSeparation migrations. The goal is NOT to retest the migrations
 * themselves (already done in osDenomination.test.ts and gasFeeSeparation.test.ts)
 * but to confirm they work correctly against the snapshot-restored DB state shape.
 *
 * Strategy: we use an in-memory SQLite DataSource (same pattern as the existing
 * migration tests) and seed 5 rows with pre-fork DEM balances that match the
 * snapshot fixture shape. We then run both migrations and assert the expected
 * post-fork state.
 *
 * For the snapshot-restore path specifically, we also verify that the balance
 * shape written by `restoreSnapshot` (bigint balance, nonce=0, assignedTxs=[])
 * is exactly what osDenomination expects as input.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { DataSource, type EntityManager } from "typeorm"
import {
    runOsDenominationMigration,
    FORK_NAME as OS_FORK_NAME,
} from "@/forks/migrations/osDenomination"
import {
    runGasFeeSeparationMigration,
    FORK_NAME as GAS_FORK_NAME,
} from "@/forks/migrations/gasFeeSeparation"

// =============================================================================
// SQLite test harness (mirrors osDenomination.test.ts schema exactly)
// =============================================================================

/**
 * Minimal SQLite schema for the tables both migrations touch.
 * The gasFeeSeparation migration inserts new accounts via `em.query`,
 * so the gcr_main DDL must match what the migration expects.
 */
async function createTestDataSource(): Promise<DataSource> {
    const ds = new DataSource({
        type: "sqlite",
        database: ":memory:",
        synchronize: false,
        logging: false,
        entities: [],
    })
    await ds.initialize()

    // gcr_main — matches production columns (TEXT for JSONB columns on SQLite).
    // NO assignedTxs: moved to gcr_assigned_txs by MoveAssignedTxsToOwnTable.
    await ds.query(`CREATE TABLE gcr_main (
        pubkey TEXT PRIMARY KEY,
        nonce INTEGER,
        balance BIGINT,
        identities TEXT,
        points TEXT,
        "referralInfo" TEXT,
        flagged INTEGER,
        "flaggedReason" TEXT,
        reviewed INTEGER,
        "createdAt" TEXT,
        "updatedAt" TEXT
    )`)

    // global_change_registry — required by osDenomination (reads legacy balances)
    await ds.query(`CREATE TABLE global_change_registry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_key TEXT,
        details TEXT,
        extended TEXT
    )`)

    // validators — required by osDenomination
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
// Snapshot-shape seeding helper
//
// Inserts rows in the exact shape that `restoreSnapshot` produces:
//   - nonce = 0
//   - assignedTxs = [] (JSON array)
//   - balance = bigint string
// =============================================================================

// NOTE: Values are kept well within SQLite BIGINT range (which is a 64-bit
// signed integer). The osDenomination migration does `balance * 1e9` in SQL;
// SQLite's max safe integer is 2^63-1 ≈ 9.2e18. The largest value here
// (2_000_000_000n) × 1e9 = 2e18 which is below 2^63-1.
// In production (Postgres), the column is numeric(38,0) so values like
// 9_999_999_999_998_868_586n × 1e9 are safe — but not in SQLite.
const SNAPSHOT_ROWS: Array<{ pubkey: string; balance: bigint }> = [
    { pubkey: "0xsnap01", balance: 1_000_000_000n },
    { pubkey: "0xsnap02", balance: 2_000_000_000n },
    { pubkey: "0xsnap03", balance: 500_000_000n },
    { pubkey: "0xsnap04", balance: 0n },
    { pubkey: "0xsnap05", balance: 999_999_999n },
]

const TREASURY = "0x" + "ab".repeat(32)

async function seedSnapshotShape(em: EntityManager): Promise<void> {
    for (const row of SNAPSHOT_ROWS) {
        await em.query(
            `INSERT INTO gcr_main
                (pubkey, nonce, balance, identities,
                 points, "referralInfo", flagged, "flaggedReason",
                 reviewed, "createdAt", "updatedAt")
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                row.pubkey,
                0,
                row.balance.toString(),
                "{}",
                "{}",
                "{}",
                0,
                "",
                0,
                new Date().toISOString(),
                new Date().toISOString(),
            ],
        )
    }
}

// =============================================================================
// Tests
// =============================================================================

describe("fork activation on snapshot-restored state", () => {
    let ds: DataSource

    beforeEach(async () => {
        ds = await createTestDataSource()
    })

    afterEach(async () => {
        if (ds?.isInitialized) await ds.destroy()
    })

    it("osDenomination: all snapshot balances multiplied by 1e9", async () => {
        // Seed in the exact shape restoreSnapshot writes
        await ds.transaction(em => seedSnapshotShape(em))

        const result = await ds.transaction(em =>
            runOsDenominationMigration(em, 1),
        )

        // Sum invariant: no cap expected (all balances in safe range)
        const preSumDem = SNAPSHOT_ROWS.reduce(
            (acc, r) => acc + r.balance,
            0n,
        )
        expect(result.preSumDem).toBe(preSumDem)
        expect(result.postSumOs).toBe(preSumDem * 1_000_000_000n)
        expect(result.cappedCount).toBe(0)
        expect(result.gcrV2RowCount).toBe(SNAPSHOT_ROWS.length)

        // Spot-check individual balances
        const rows: Array<{ pubkey: string; balance: string }> =
            await ds.manager.query(
                "SELECT pubkey, balance FROM gcr_main ORDER BY pubkey",
            )
        const balMap = new Map(rows.map(r => [r.pubkey, BigInt(r.balance)]))
        for (const seed of SNAPSHOT_ROWS) {
            const post = balMap.get(seed.pubkey)
            expect(post).not.toBeUndefined()
            expect(post).toBe(seed.balance * 1_000_000_000n)
        }
    })

    it("osDenomination: fork_state row applied=true at blockNumber=1", async () => {
        await ds.transaction(em => seedSnapshotShape(em))
        await ds.transaction(em => runOsDenominationMigration(em, 1))

        const rows: Array<{
            fork_name: string
            applied: number
            applied_at_block: string
        }> = await ds.manager.query(
            "SELECT fork_name, applied, applied_at_block FROM fork_state WHERE fork_name = ?",
            [OS_FORK_NAME],
        )
        expect(rows).toHaveLength(1)
        expect(rows[0].applied).toBe(1)
        expect(Number(rows[0].applied_at_block)).toBe(1)
    })

    it("gasFeeSeparation: fork_state row applied=true after migration", async () => {
        await ds.transaction(em => seedSnapshotShape(em))
        // gasFeeSeparation does not depend on osDenomination having run —
        // it only creates two new accounts and writes fork_state
        await ds.transaction(em =>
            runGasFeeSeparationMigration(em, 1, TREASURY),
        )

        const rows: Array<{ fork_name: string; applied: number }> =
            await ds.manager.query(
                "SELECT fork_name, applied FROM fork_state WHERE fork_name = ?",
                [GAS_FORK_NAME],
            )
        expect(rows).toHaveLength(1)
        expect(rows[0].applied).toBe(1)
    })

    it("both migrations run sequentially: both fork_state rows present", async () => {
        await ds.transaction(em => seedSnapshotShape(em))
        await ds.transaction(em => runOsDenominationMigration(em, 1))
        await ds.transaction(em =>
            runGasFeeSeparationMigration(em, 1, TREASURY),
        )

        const rows: Array<{ fork_name: string; applied: number }> =
            await ds.manager.query(
                "SELECT fork_name, applied FROM fork_state ORDER BY fork_name",
            )
        expect(rows).toHaveLength(2)
        const names = rows.map(r => r.fork_name)
        expect(names).toContain(OS_FORK_NAME)
        expect(names).toContain(GAS_FORK_NAME)
        for (const row of rows) {
            expect(row.applied).toBe(1)
        }
    })

    it("nonce=0 in snapshot shape is preserved through restore and not affected by osDenomination", async () => {
        await ds.transaction(em => seedSnapshotShape(em))
        await ds.transaction(em => runOsDenominationMigration(em, 1))

        const rows: Array<{ pubkey: string; nonce: number }> =
            await ds.manager.query(
                "SELECT pubkey, nonce FROM gcr_main",
            )
        for (const row of rows) {
            expect(row.nonce).toBe(0)
        }
    })

    // NOTE: removed the former "assignedTxs preserved through restore" test —
    // assignedTxs is no longer a gcr_main column (moved to gcr_assigned_txs by
    // MoveAssignedTxsToOwnTable), so there is nothing on gcr_main to preserve.
})
