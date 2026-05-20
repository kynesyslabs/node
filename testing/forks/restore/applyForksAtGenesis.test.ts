/**
 * P7-T1 — Unit + integration tests for `applyForksAtGenesis`.
 *
 * Exercises the pure orchestrator that pre-applies osDenomination and
 * gasFeeSeparation inside the genesis transaction (block 0), making a
 * fresh node boot fully post-fork without needing consensus quorum to
 * produce block 1.
 *
 * All tests use an in-memory SQLite DataSource (same pattern as the
 * existing migration tests) so no Postgres connection is required.
 *
 * Test matrix:
 *   1. Happy path — both forks applied, state correct.
 *   2. osDenomination null → skipped; report.osDenominationApplied=false.
 *   3. gasFeeSeparation null → skipped; report.gasFeeSeparationApplied=false.
 *   4. Both null → report all false, no DB mutations.
 *   5. forks=undefined → returns immediately with all false.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { DataSource, type EntityManager } from "typeorm"
import {
    applyForksAtGenesis,
    type GenesisForkConfig,
} from "@/libs/blockchain/genesis/applyForksAtGenesis"
import { FORK_NAME as OS_FORK_NAME } from "@/forks/migrations/osDenomination"
import { FORK_NAME as GAS_FORK_NAME } from "@/forks/migrations/gasFeeSeparation"

// =============================================================================
// SQLite harness
// =============================================================================

async function createTestDataSource(): Promise<DataSource> {
    const ds = new DataSource({
        type: "sqlite",
        database: ":memory:",
        synchronize: false,
        logging: false,
        entities: [],
    })
    await ds.initialize()

    // gcr_main — all columns that migrations touch
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

    // global_change_registry — required by osDenomination (no legacy rows in
    // tests but the migration always queries this table)
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
// Seed helpers
// =============================================================================

// Balances chosen to stay within SQLite BIGINT arithmetic range after × 1e9.
const GCR_ROWS: Array<{ pubkey: string; balance: bigint }> = [
    { pubkey: "0xpk01", balance: 1_000_000_000n },
    { pubkey: "0xpk02", balance: 2_000_000_000n },
    { pubkey: "0xpk03", balance: 500_000_000n },
    { pubkey: "0xpk04", balance: 0n },
    { pubkey: "0xpk05", balance: 999_999_999n },
]

const VALIDATOR_ROWS: Array<{ address: string; staked_amount: bigint }> = [
    { address: "0xval01", staked_amount: 1_000_000_000n },
    { address: "0xval02", staked_amount: 1_000_000_000n },
    { address: "0xval03", staked_amount: 1_000_000_000n },
    { address: "0xval04", staked_amount: 1_000_000_000n },
    { address: "0xval05", staked_amount: 1_000_000_000n },
]

const TREASURY = "0x" + "ab".repeat(32) // valid 66-char lowercase hex

async function seedState(em: EntityManager): Promise<void> {
    const now = new Date().toISOString()
    for (const row of GCR_ROWS) {
        await em.query(
            `INSERT INTO gcr_main
                (pubkey, "assignedTxs", nonce, balance, identities, points,
                 "referralInfo", flagged, "flaggedReason", reviewed,
                 "createdAt", "updatedAt")
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                row.pubkey,
                "[]",
                0,
                row.balance.toString(),
                "{}",
                "{}",
                "{}",
                0,
                "",
                0,
                now,
                now,
            ],
        )
    }
    for (const v of VALIDATOR_ROWS) {
        await em.query(
            `INSERT INTO validators
                (address, status, connection_url, staked_amount, first_seen, valid_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [v.address, "2", "http://localhost", v.staked_amount.toString(), 0, 0],
        )
    }
}

// =============================================================================
// Tests
// =============================================================================

describe("applyForksAtGenesis", () => {
    let ds: DataSource

    beforeEach(async () => {
        ds = await createTestDataSource()
    })

    afterEach(async () => {
        if (ds?.isInitialized) await ds.destroy()
    })

    // -------------------------------------------------------------------------
    // Test 1: Happy path — both forks applied
    // -------------------------------------------------------------------------

    it("happy path: both forks applied → balances × 1e9, burn + treasury accounts, fork_state populated", async () => {
        // Seed state inside the same transaction we hand to applyForksAtGenesis
        // (mirrors how chainGenesis.ts nests restoreSnapshot + seedValidators +
        //  applyForksAtGenesis in one transaction).
        const report = await ds.transaction(async em => {
            await seedState(em)
            const forksConfig: GenesisForkConfig = {
                osDenomination: { activationHeight: 1 },
                gasFeeSeparation: {
                    activationHeight: 1,
                    treasuryAddress: TREASURY,
                },
            }
            return applyForksAtGenesis(em, forksConfig)
        })

        expect(report.osDenominationApplied).toBe(true)
        expect(report.gasFeeSeparationApplied).toBe(true)
        expect(report.elapsed_ms).toBeGreaterThanOrEqual(0)

        // gcr_main balances × 1e9
        const gcrRows: Array<{ pubkey: string; balance: string }> =
            await ds.query("SELECT pubkey, balance FROM gcr_main ORDER BY pubkey")

        const balMap = new Map(
            gcrRows
                .filter(r => GCR_ROWS.some(g => g.pubkey === r.pubkey))
                .map(r => [r.pubkey, BigInt(r.balance)]),
        )
        for (const seed of GCR_ROWS) {
            expect(balMap.get(seed.pubkey)).toBe(seed.balance * 1_000_000_000n)
        }

        // validator staked_amounts × 1e9
        const valRows: Array<{ address: string; staked_amount: string }> =
            await ds.query("SELECT address, staked_amount FROM validators ORDER BY address")
        for (const seed of VALIDATOR_ROWS) {
            const row = valRows.find(v => v.address === seed.address)
            expect(row).not.toBeUndefined()
            expect(BigInt(row!.staked_amount)).toBe(seed.staked_amount * 1_000_000_000n)
        }

        // fork_state: both rows applied at block 0
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
        expect(Number(osRow!.applied_at_block)).toBe(0)

        const gasRow = forkMap.get(GAS_FORK_NAME)
        expect(gasRow).not.toBeUndefined()
        expect(gasRow!.applied).toBe(1)
        expect(Number(gasRow!.applied_at_block)).toBe(0)

        // Burn account exists (balance=0)
        const BURN = "0x" + "0".repeat(64)
        const burnRows: Array<{ pubkey: string; balance: string }> =
            await ds.query(
                "SELECT pubkey, balance FROM gcr_main WHERE pubkey = ?",
                [BURN],
            )
        expect(burnRows).toHaveLength(1)
        expect(BigInt(burnRows[0].balance)).toBe(0n)

        // Treasury account exists (balance=0)
        const treasuryRows: Array<{ pubkey: string; balance: string }> =
            await ds.query(
                "SELECT pubkey, balance FROM gcr_main WHERE pubkey = ?",
                [TREASURY],
            )
        expect(treasuryRows).toHaveLength(1)
        expect(BigInt(treasuryRows[0].balance)).toBe(0n)
    })

    // -------------------------------------------------------------------------
    // Test 2: osDenomination activationHeight=null → skip
    // -------------------------------------------------------------------------

    it("null activationHeight does NOT skip pre-apply (presence of forks block triggers it)", async () => {
        // Production config has activationHeight=null because the block-N
        // hook in chainBlocks.ts must stay dormant (forks already applied
        // at genesis). Pre-apply still runs because the forks block exists.
        const report = await ds.transaction(async em => {
            await seedState(em)
            const forksConfig: GenesisForkConfig = {
                osDenomination: { activationHeight: null },
                gasFeeSeparation: {
                    activationHeight: null,
                    treasuryAddress: TREASURY,
                },
            }
            return applyForksAtGenesis(em, forksConfig)
        })

        expect(report.osDenominationApplied).toBe(true)
        expect(report.gasFeeSeparationApplied).toBe(true)

        // Balances scaled by 1e9
        const gcrRows: Array<{ pubkey: string; balance: string }> =
            await ds.query(
                "SELECT pubkey, balance FROM gcr_main WHERE pubkey IN (?, ?, ?, ?, ?) ORDER BY pubkey",
                GCR_ROWS.map(r => r.pubkey),
            )
        const balMap = new Map(gcrRows.map(r => [r.pubkey, BigInt(r.balance)]))
        for (const seed of GCR_ROWS) {
            expect(balMap.get(seed.pubkey)).toBe(seed.balance * 1_000_000_000n)
        }

        // fork_state rows present for both forks
        const forkRows: Array<{ fork_name: string }> = await ds.query(
            "SELECT fork_name FROM fork_state ORDER BY fork_name",
        )
        expect(forkRows).toHaveLength(2)
    })

    // -------------------------------------------------------------------------
    // Test 3: Partial forks block — only osDenomination key present
    // -------------------------------------------------------------------------

    it("only osDenomination key present → only osDenomination applied", async () => {
        const report = await ds.transaction(async em => {
            await seedState(em)
            // gasFeeSeparation key entirely absent
            const forksConfig = {
                osDenomination: { activationHeight: null },
            } as unknown as GenesisForkConfig
            return applyForksAtGenesis(em, forksConfig)
        })

        expect(report.osDenominationApplied).toBe(true)
        expect(report.gasFeeSeparationApplied).toBe(false)

        // No burn or treasury accounts
        const BURN = "0x" + "0".repeat(64)
        const specialRows: Array<{ pubkey: string }> = await ds.query(
            "SELECT pubkey FROM gcr_main WHERE pubkey IN (?, ?)",
            [BURN, TREASURY],
        )
        expect(specialRows).toHaveLength(0)

        const gasRows: Array<{ fork_name: string }> = await ds.query(
            "SELECT fork_name FROM fork_state WHERE fork_name = ?",
            [GAS_FORK_NAME],
        )
        expect(gasRows).toHaveLength(0)
    })

    // -------------------------------------------------------------------------
    // Test 4: Empty forks object — no sub-keys → both skip, no DB mutations
    // -------------------------------------------------------------------------

    it("empty forks object → all false, no DB mutations", async () => {
        const report = await ds.transaction(async em => {
            await seedState(em)
            const forksConfig = {} as unknown as GenesisForkConfig
            return applyForksAtGenesis(em, forksConfig)
        })

        expect(report.osDenominationApplied).toBe(false)
        expect(report.gasFeeSeparationApplied).toBe(false)

        // Balances untouched
        const gcrRows: Array<{ pubkey: string; balance: string }> =
            await ds.query(
                "SELECT pubkey, balance FROM gcr_main WHERE pubkey IN (?, ?, ?, ?, ?) ORDER BY pubkey",
                GCR_ROWS.map(r => r.pubkey),
            )
        const balMap = new Map(gcrRows.map(r => [r.pubkey, BigInt(r.balance)]))
        for (const seed of GCR_ROWS) {
            expect(balMap.get(seed.pubkey)).toBe(seed.balance)
        }

        const forkRows: Array<{ fork_name: string }> = await ds.query(
            "SELECT fork_name FROM fork_state",
        )
        expect(forkRows).toHaveLength(0)
    })

    // -------------------------------------------------------------------------
    // Test 5: forks=undefined → immediate early return
    // -------------------------------------------------------------------------

    it("forks=undefined → returns immediately with all false, elapsed_ms=0", async () => {
        const report = await ds.transaction(async em => {
            await seedState(em)
            return applyForksAtGenesis(em, undefined)
        })

        expect(report.osDenominationApplied).toBe(false)
        expect(report.gasFeeSeparationApplied).toBe(false)
        expect(report.elapsed_ms).toBe(0)

        // No fork_state rows written
        const forkRows: Array<{ fork_name: string }> = await ds.query(
            "SELECT fork_name FROM fork_state",
        )
        expect(forkRows).toHaveLength(0)
    })

    // -------------------------------------------------------------------------
    // Test 6: applied_at_block stored as 0 (genesis block)
    // -------------------------------------------------------------------------

    it("both forks applied: fork_state.applied_at_block is 0, not 1", async () => {
        await ds.transaction(async em => {
            await seedState(em)
            const forksConfig: GenesisForkConfig = {
                osDenomination: { activationHeight: 1 },
                gasFeeSeparation: {
                    activationHeight: 1,
                    treasuryAddress: TREASURY,
                },
            }
            return applyForksAtGenesis(em, forksConfig)
        })

        const forkRows: Array<{
            fork_name: string
            applied_at_block: string
        }> = await ds.query(
            "SELECT fork_name, applied_at_block FROM fork_state ORDER BY fork_name",
        )

        for (const row of forkRows) {
            expect(Number(row.applied_at_block)).toBe(0)
        }
    })

    // -------------------------------------------------------------------------
    // Test 7: report.elapsed_ms is a non-negative number when work done
    // -------------------------------------------------------------------------

    it("report.elapsed_ms is a non-negative number", async () => {
        const report = await ds.transaction(async em => {
            await seedState(em)
            return applyForksAtGenesis(em, {
                osDenomination: { activationHeight: 1 },
                gasFeeSeparation: {
                    activationHeight: 1,
                    treasuryAddress: TREASURY,
                },
            })
        })

        expect(typeof report.elapsed_ms).toBe("number")
        expect(report.elapsed_ms).toBeGreaterThanOrEqual(0)
    })
})
