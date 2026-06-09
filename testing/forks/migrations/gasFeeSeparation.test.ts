/**
 * DEM-665 — gasFeeSeparation state migration tests.
 *
 * Same test-isolation strategy as osDenomination.test.ts: an in-memory
 * sqlite DataSource per test, minimal raw DDL for only the tables the
 * migration touches (`gcr_main`, `fork_state`). The migration code is
 * written against `EntityManager.query` with a Postgres/sqlite-portable
 * `placeholder()` helper, so the same code runs against production
 * Postgres and these tests.
 *
 * Production environment is Postgres only — sqlite is exclusively the
 * test harness. Driver-specific branches in the migration are exercised
 * via the `connection.options.type` switch in `placeholder()`.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { DataSource, type EntityManager } from "typeorm"
import {
    BURN_ADDRESS,
    FORK_NAME,
    isGasFeeSeparationMigrationApplied,
    runGasFeeSeparationMigration,
} from "@/forks/migrations/gasFeeSeparation"
import { GAS_FEE_SEPARATION_BURN_ADDRESS } from "@/forks/loadForkConfig"

const VALID_TREASURY = "0x" + "ab".repeat(32)

/**
 * Spin up a fresh in-memory sqlite DataSource with the minimal schema
 * the gasFeeSeparation migration needs.
 *
 * `gcr_main` mirrors the production columns the migration writes; JSONB
 * columns are TEXT here (sqlite has no JSONB type — the migration writes
 * the canonical JSON string in both cases, so round-tripping through TEXT
 * is bit-identical to JSONB for this code path).
 *
 * `fork_state` mirrors the schema introduced by osDenomination — most
 * columns are nullable here because gasFeeSeparation only writes
 * `fork_name`, `applied`, `applied_at_block`, `applied_at`.
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
    // Mirror the real Postgres gcr_main schema: NO assignedTxs column (it was
    // moved to gcr_assigned_txs by MoveAssignedTxsToOwnTable). Keeping it here
    // previously masked the gasFeeSeparation migration's bad INSERT.
    await ds.query(`CREATE TABLE gcr_main (
        pubkey TEXT PRIMARY KEY,
        nonce INTEGER,
        balance TEXT,
        identities TEXT,
        points TEXT,
        "referralInfo" TEXT,
        flagged INTEGER,
        "flaggedReason" TEXT,
        reviewed INTEGER,
        "createdAt" TEXT,
        "updatedAt" TEXT
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

async function seedExistingAccount(
    em: EntityManager,
    pubkey: string,
    balance: bigint,
) {
    await em.query(
        `INSERT INTO gcr_main (
            pubkey, nonce, balance, identities,
            points, "referralInfo", flagged, "flaggedReason",
            reviewed, "createdAt", "updatedAt"
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            pubkey,
            0,
            balance.toString(),
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

async function getAccount(
    em: EntityManager,
    pubkey: string,
): Promise<{ pubkey: string; balance: string } | null> {
    const rows: Array<{ pubkey: string; balance: string }> = await em.query(
        "SELECT pubkey, balance FROM gcr_main WHERE pubkey = ?",
        [pubkey],
    )
    return rows.length > 0 ? rows[0] : null
}

describe("gasFeeSeparation migration", () => {
    let ds: DataSource
    let em: EntityManager

    beforeEach(async () => {
        ds = await createTestDataSource()
        em = ds.manager
    })

    afterEach(async () => {
        await ds.destroy()
    })

    // ------------------------------------------------------------------
    // Constants alignment
    // ------------------------------------------------------------------

    it("BURN_ADDRESS in migration matches the loader-side mirror", () => {
        // Both files declare the same constant. A unit test pinning this
        // equality is the firewall against accidental drift in a future
        // edit.
        expect(BURN_ADDRESS).toBe(GAS_FEE_SEPARATION_BURN_ADDRESS)
        expect(BURN_ADDRESS).toBe("0x" + "0".repeat(64))
    })

    it("FORK_NAME constant matches the registered fork name", () => {
        expect(FORK_NAME).toBe("gasFeeSeparation")
    })

    // ------------------------------------------------------------------
    // Idempotency
    // ------------------------------------------------------------------

    it("isGasFeeSeparationMigrationApplied returns false on a fresh DB", async () => {
        expect(await isGasFeeSeparationMigrationApplied(em)).toBe(false)
    })

    it("isGasFeeSeparationMigrationApplied returns true after a successful run", async () => {
        await runGasFeeSeparationMigration(em, 100, VALID_TREASURY)
        expect(await isGasFeeSeparationMigrationApplied(em)).toBe(true)
    })

    it("re-running on an already-applied DB throws", async () => {
        await runGasFeeSeparationMigration(em, 100, VALID_TREASURY)
        await expect(
            runGasFeeSeparationMigration(em, 200, VALID_TREASURY),
        ).rejects.toThrow(/already applied/)
    })

    // ------------------------------------------------------------------
    // Account creation
    // ------------------------------------------------------------------

    it("creates burn account with balance 0 on first run", async () => {
        await runGasFeeSeparationMigration(em, 100, VALID_TREASURY)
        const burn = await getAccount(em, BURN_ADDRESS)
        expect(burn).not.toBeNull()
        expect(burn!.balance).toBe("0")
    })

    it("creates treasury account with balance 0 on first run", async () => {
        await runGasFeeSeparationMigration(em, 100, VALID_TREASURY)
        const treasury = await getAccount(em, VALID_TREASURY)
        expect(treasury).not.toBeNull()
        expect(treasury!.balance).toBe("0")
    })

    it("returns the burn/treasury addresses + created-flags in the result", async () => {
        const result = await runGasFeeSeparationMigration(
            em,
            100,
            VALID_TREASURY,
        )
        expect(result.burnAddress).toBe(BURN_ADDRESS)
        expect(result.treasuryAddress).toBe(VALID_TREASURY)
        expect(result.burnAccountCreated).toBe(true)
        expect(result.treasuryAccountCreated).toBe(true)
    })

    it("leaves an existing burn account untouched", async () => {
        // Operator pre-seeded the burn address in genesis with a non-zero
        // balance for some legacy reason. Migration must NOT overwrite —
        // it returns the pre-existing balance as-is.
        await seedExistingAccount(em, BURN_ADDRESS, 42n)
        const result = await runGasFeeSeparationMigration(
            em,
            100,
            VALID_TREASURY,
        )
        expect(result.burnAccountCreated).toBe(false)
        const burn = await getAccount(em, BURN_ADDRESS)
        expect(burn!.balance).toBe("42")
    })

    it("leaves an existing treasury account untouched", async () => {
        await seedExistingAccount(em, VALID_TREASURY, 1000n)
        const result = await runGasFeeSeparationMigration(
            em,
            100,
            VALID_TREASURY,
        )
        expect(result.treasuryAccountCreated).toBe(false)
        const treasury = await getAccount(em, VALID_TREASURY)
        expect(treasury!.balance).toBe("1000")
    })

    it("persists fork_state row with correct fork_name and applied_at_block", async () => {
        await runGasFeeSeparationMigration(em, 12345, VALID_TREASURY)
        const rows: Array<{
            fork_name: string
            applied: number
            applied_at_block: string
        }> = await em.query(
            "SELECT fork_name, applied, applied_at_block FROM fork_state",
        )
        expect(rows.length).toBe(1)
        expect(rows[0].fork_name).toBe(FORK_NAME)
        // sqlite normalises BOOLEAN to INTEGER 0/1.
        expect(rows[0].applied).toBe(1)
        expect(Number(rows[0].applied_at_block)).toBe(12345)
    })

    // ------------------------------------------------------------------
    // Defence-in-depth address validation
    // ------------------------------------------------------------------

    it("throws when treasuryAddress is not a string", async () => {
        await expect(
            runGasFeeSeparationMigration(
                em,
                100,
                12345 as unknown as string,
            ),
        ).rejects.toThrow(/treasuryAddress must match/)
    })

    it("throws on malformed treasuryAddress hex", async () => {
        await expect(
            runGasFeeSeparationMigration(em, 100, "0xnotreallyhex"),
        ).rejects.toThrow(/treasuryAddress must match/)
    })

    it("throws on uppercase hex treasuryAddress", async () => {
        await expect(
            runGasFeeSeparationMigration(
                em,
                100,
                "0x" + "AB".repeat(32),
            ),
        ).rejects.toThrow(/treasuryAddress must match/)
    })

    it("throws when treasuryAddress equals BURN_ADDRESS", async () => {
        await expect(
            runGasFeeSeparationMigration(em, 100, BURN_ADDRESS),
        ).rejects.toThrow(/equals BURN_ADDRESS/)
    })

    // ------------------------------------------------------------------
    // Same-block ordering with osDenomination — sanity-only check
    // ------------------------------------------------------------------

    it("can run alongside an existing osDenomination fork_state row", async () => {
        // Simulate osDenomination having already written its row in the
        // same transaction. gasFeeSeparation must coexist (different
        // fork_name PK).
        await em.query(
            `INSERT INTO fork_state (
                fork_name, applied, applied_at_block, applied_at,
                pre_sum_dem, post_sum_os
            ) VALUES (?, ?, ?, ?, ?, ?)`,
            [
                "osDenomination",
                1,
                100,
                new Date().toISOString(),
                "1000000",
                "1000000000000000",
            ],
        )
        await runGasFeeSeparationMigration(em, 100, VALID_TREASURY)
        const rows: Array<{ fork_name: string }> = await em.query(
            "SELECT fork_name FROM fork_state ORDER BY fork_name",
        )
        expect(rows.map(r => r.fork_name)).toEqual([
            FORK_NAME,
            "osDenomination",
        ])
    })
})
