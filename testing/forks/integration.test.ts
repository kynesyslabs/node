/**
 * P3d — End-to-end integration tests for the osDenomination fork pipeline.
 *
 * Unit tests in this directory pin individual concerns:
 *   - forkGates.test.ts          — gate truth table
 *   - serializerGate.test.ts     — bit-identical regression
 *   - postForkSerializer.test.ts — OS-string conversion
 *   - forkBoundary.test.ts       — height-dispatch
 *   - loadForkConfig.test.ts     — genesis loading
 *   - migrations/osDenomination.test.ts — migration logic in isolation
 *   - getNetworkInfo.test.ts     — RPC handler
 *
 * These tests exercise multiple subsystems at once, simulating real-world
 * flows that cross the fork boundary. They're the safety net that catches
 * wiring bugs unit tests cannot see.
 *
 * Test isolation strategy: identical to `migrations/osDenomination.test.ts`
 * — an in-memory sqlite DataSource per test, schema mirrored from the
 * production columns the migration touches. SharedState forkConfig and
 * lastBlockNumber are snapshotted/restored around each test so other
 * suites are not contaminated.
 *
 * STOP-conditions evaluated up-front (per task brief):
 *   - `runOsDenominationMigration` IS exported from `@/forks/migrations/osDenomination`
 *     (re-exported through `@/forks` index). Confirmed: callable in
 *     isolation, no need to spin up Chain.insertBlock.
 *   - Scenario 4 (RPC vs lastBlockNumber sweep) is fully covered by
 *     `getNetworkInfo.test.ts`. Skipped per the brief; only a single
 *     consistency check between the migration result and `getNetworkInfo`
 *     is kept inside Scenario 1, where it verifies the wiring rather than
 *     re-testing the handler.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { DataSource, type EntityManager } from "typeorm"
import {
    runOsDenominationMigration,
    isOsDenominationMigrationApplied,
    FORK_NAME,
} from "@/forks/migrations/osDenomination"
import { serializeTransactionContent } from "@/forks/serializerGate"
import {
    cloneDefaultForkConfig,
    type ForkConfigByName,
} from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"
import Hashing from "@/libs/crypto/hashing"
// REVIEW: Import getNetworkInfo via the registry (mirroring the pattern in
// getNetworkInfo.test.ts) to dodge the ESM circular import between
// forkHandlers and SharedState.
import { handlerRegistry } from "@/libs/network/handlers"
import type {
    TransactionContent,
    RPCResponse,
} from "@kynesyslabs/demosdk/types"

// =============================================================================
// Test harness — copied verbatim from migrations/osDenomination.test.ts so
// that this file is self-contained and the two suites cannot diverge in
// schema definitions silently.
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

    await ds.query(`CREATE TABLE gcr_main (
        pubkey TEXT PRIMARY KEY,
        balance BIGINT
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

async function seedGcrV2(
    em: EntityManager,
    rows: Array<{ pubkey: string; balance: bigint }>,
) {
    for (const r of rows) {
        await em.query(
            "INSERT INTO gcr_main (pubkey, balance) VALUES (?, ?)",
            [r.pubkey, r.balance.toString()],
        )
    }
}

async function seedLegacy(
    em: EntityManager,
    rows: Array<{
        publicKey: string
        balanceDem: number
        identityKey?: string
    }>,
) {
    for (const r of rows) {
        const details = {
            hash: "test_hash_" + r.publicKey,
            content: {
                balance: r.balanceDem,
                identities: r.identityKey ? { [r.identityKey]: {} } : {},
                txs: [],
                nonce: 0,
            },
        }
        await em.query(
            "INSERT INTO global_change_registry (public_key, details, extended) VALUES (?, ?, ?)",
            [r.publicKey, JSON.stringify(details), JSON.stringify({})],
        )
    }
}

async function seedValidators(
    em: EntityManager,
    rows: Array<{ address: string; stakedDem: bigint }>,
) {
    for (const r of rows) {
        await em.query(
            "INSERT INTO validators (address, staked_amount) VALUES (?, ?)",
            [r.address, r.stakedDem.toString()],
        )
    }
}

async function getGcrV2Balances(
    em: EntityManager,
): Promise<Map<string, bigint>> {
    const rows: Array<{ pubkey: string; balance: string }> = await em.query(
        "SELECT pubkey, balance FROM gcr_main",
    )
    return new Map(rows.map(r => [r.pubkey, BigInt(r.balance)]))
}

async function getLegacyBalances(
    em: EntityManager,
): Promise<Map<string, number>> {
    const rows: Array<{ public_key: string; details: string }> =
        await em.query(
            "SELECT public_key, details FROM global_change_registry",
        )
    const map = new Map<string, number>()
    for (const r of rows) {
        const parsed = JSON.parse(r.details)
        map.set(r.public_key, parsed.content.balance as number)
    }
    return map
}

async function getValidatorStakes(
    em: EntityManager,
): Promise<Map<string, bigint>> {
    const rows: Array<{ address: string; staked_amount: string }> =
        await em.query("SELECT address, staked_amount FROM validators")
    return new Map(rows.map(r => [r.address, BigInt(r.staked_amount)]))
}

async function getForkStateRow(em: EntityManager) {
    const rows: Array<Record<string, unknown>> = await em.query(
        "SELECT * FROM fork_state WHERE fork_name = ?",
        [FORK_NAME],
    )
    return rows[0] ?? null
}

/**
 * Mirrors `chainBlocks.insertBlock`'s fork-activation hook: open a TypeORM
 * transaction, run the migration if (and only if) the fork is active and
 * not already applied. Returns the migration result, or `null` if the hook
 * was a no-op for this height. The intent is to faithfully replay the
 * production wiring — same gate, same idempotency check, same atomic
 * transaction boundary — without needing the whole Chain stack.
 *
 * `chainBlocks.insertBlock:217-240` is the reference implementation.
 */
async function simulateBlockInsertActivationHook(
    dataSource: DataSource,
    blockHeight: number,
) {
    return await dataSource.transaction(async em => {
        const { isForkActive } = await import("@/forks/forkGates")
        if (!isForkActive("osDenomination", blockHeight)) return null
        if (await isOsDenominationMigrationApplied(em)) return null
        return await runOsDenominationMigration(em, blockHeight)
    })
}

interface NetworkInfoResponse {
    forks: {
        osDenomination: {
            activationHeight: number | null
            activated: boolean
            currentHeight: number
        }
    }
}

function makeRpcResponse(): RPCResponse {
    return {
        result: 0,
        response: "",
        require_reply: false,
        extra: null,
    }
}

// =============================================================================
// Tests
// =============================================================================

describe("forks integration (P3d)", () => {
    let dataSource: DataSource
    let forkSnapshot: ForkConfigByName
    let blockNumberSnapshot: number

    beforeEach(async () => {
        dataSource = await createTestDataSource()
        forkSnapshot = cloneDefaultForkConfig()
        blockNumberSnapshot = getSharedState.lastBlockNumber
        getSharedState.forkConfig = cloneDefaultForkConfig()
    })

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy()
        getSharedState.forkConfig = forkSnapshot
        getSharedState.lastBlockNumber = blockNumberSnapshot
    })

    // -------------------------------------------------------------------------
    // Scenario 1 — Snapshot replay across fork height.
    //
    // A historical re-sync must produce the same post-fork state as a node
    // that processed the activation block live. We seed all three balance
    // sources, fire the activation hook at block 10, and assert: balances
    // are × 10^9, fork_state is recorded, and getNetworkInfo (driven by
    // SharedState.lastBlockNumber) reflects activation truthfully.
    // -------------------------------------------------------------------------
    it("scenario 1: snapshot replay across fork height multiplies all sources by 10^9", async () => {
        getSharedState.forkConfig.osDenomination.activationHeight = 10

        // Seed pre-fork (DEM) state. Legacy `global_change_registry` is no
        // longer in the runtime path (the entity, the migration, and the
        // backend table were retired); only gcr_main + validators are
        // touched by the activation hook now.
        await dataSource.transaction(async em => {
            await seedGcrV2(em, [
                { pubkey: "addr_a", balance: 100n },
                { pubkey: "addr_b", balance: 250n },
                { pubkey: "addr_c", balance: 0n },
                { pubkey: "addr_d", balance: 1_000_000n },
                { pubkey: "addr_e", balance: 42n },
            ])
            await seedValidators(em, [
                { address: "v_alpha", stakedDem: 5_000n },
                { address: "v_beta", stakedDem: 12_345n },
            ])
        })

        // Snapshot the pre-state for assertion comparisons.
        const preGcrV2 = await getGcrV2Balances(dataSource.manager)
        const preStakes = await getValidatorStakes(dataSource.manager)

        // Fire the activation hook the way `chainBlocks.insertBlock` does
        // when it sees its first block at >= activationHeight.
        const result = await simulateBlockInsertActivationHook(dataSource, 10)
        expect(result).not.toBeNull()

        // GCRv2: every balance × 10^9.
        const postGcrV2 = await getGcrV2Balances(dataSource.manager)
        for (const [pk, preBalance] of preGcrV2) {
            expect(postGcrV2.get(pk)).toBe(preBalance * 1_000_000_000n)
        }

        // Validators: every stake × 10^9 (text bigint preserved).
        const postStakes = await getValidatorStakes(dataSource.manager)
        for (const [addr, preStake] of preStakes) {
            expect(postStakes.get(addr)).toBe(preStake * 1_000_000_000n)
        }

        // fork_state was written.
        const fsRow = await getForkStateRow(dataSource.manager)
        expect(fsRow).not.toBeNull()
        expect(fsRow!.applied).toBe(1)
        expect(fsRow!.applied_at_block).toBe(10)

        // RPC consistency: getNetworkInfo must agree with the gate decision
        // taken by the migration hook.  This is the *integration* check
        // that the unit test for getNetworkInfo cannot make: the same
        // SharedState that drove the hook now drives the handler.
        getSharedState.lastBlockNumber = 10
        const rpc = await handlerRegistry.getNetworkInfo({}, makeRpcResponse())
        const body = rpc.response as NetworkInfoResponse
        expect(body.forks.osDenomination.activated).toBe(true)
        expect(body.forks.osDenomination.activationHeight).toBe(10)
        expect(body.forks.osDenomination.currentHeight).toBe(10)
    })

    // -------------------------------------------------------------------------
    // Scenario 2 — Hash distinctness across the fork boundary.
    //
    // The whole point of a hard fork: the same logical content hashed at
    // height N-1 vs N produces different bytes, so signatures committed
    // pre-fork cannot validate post-fork. The unit suite already pins the
    // serializer; this test validates that the same serializer feeds the
    // node's hashing primitive correctly (i.e. no missing wiring between
    // the gate decision and the eventual SHA-256 input).
    // -------------------------------------------------------------------------
    it("scenario 2: same logical tx hashes differently across the fork boundary", () => {
        getSharedState.forkConfig.osDenomination.activationHeight = 100

        const content: TransactionContent = {
            type: "native",
            from: "0x" + "ab".repeat(32),
            from_ed25519_address: "0x" + "cd".repeat(32),
            to: "0x" + "ef".repeat(32),
            amount: 100,
            data: ["native", { description: "boundary" }] as any,
            gcr_edits: [],
            nonce: 7,
            timestamp: 1_700_000_000_000,
            transaction_fee: {
                network_fee: 1,
                rpc_fee: 1,
                additional_fee: 1,
                rpc_address: null,
            },
        }

        const preForkBytes = serializeTransactionContent(content, 99)
        const postForkBytes = serializeTransactionContent(content, 100)
        const preForkHash = Hashing.sha256(preForkBytes)
        const postForkHash = Hashing.sha256(postForkBytes)

        // Hashes diverge.
        expect(preForkHash).not.toBe(postForkHash)

        // Pre-fork bytes are byte-identical to JSON.stringify (legacy path
        // remains untouched).
        expect(preForkBytes).toBe(JSON.stringify(content))

        // Post-fork bytes carry the OS-string amount.
        expect(postForkBytes.includes("\"amount\":\"100000000000\"")).toBe(true)

        // Both serialisations are still valid JSON and parse back to plain
        // objects — defends against a regression that emits broken JSON
        // (e.g. a stray `bigint` token).
        expect(() => JSON.parse(preForkBytes)).not.toThrow()
        expect(() => JSON.parse(postForkBytes)).not.toThrow()

        // Hash strings must be 64-char hex (sha-256). Defensive sanity to
        // catch a Hashing module regression that returns the raw digest
        // bytes or a different algorithm.
        expect(preForkHash).toMatch(/^[0-9a-f]{64}$/)
        expect(postForkHash).toMatch(/^[0-9a-f]{64}$/)
    })

    // -------------------------------------------------------------------------
    // Scenario 3 — Idempotency across simulated restart.
    //
    // After block 10 commits the migration, a node restart must not re-run
    // the migration on block 11. Re-running would multiply balances by
    // 10^18 — catastrophic. We assert that:
    //   1. Block 11's hook is a no-op (gated by isOsDenominationMigrationApplied).
    //   2. fork_state.applied_at_block is still 10, never 11.
    //   3. Balances are × 10^9 of the pre-state, NEVER × 10^18.
    //
    // "Restart" is simulated by running a *separate* hook invocation on the
    // same DataSource without touching fork_state — which models the
    // production reality: the database persists across the restart, only
    // in-process state (SharedState) is discarded.
    // -------------------------------------------------------------------------
    it("scenario 3: migration is idempotent across simulated restart", async () => {
        getSharedState.forkConfig.osDenomination.activationHeight = 10

        // Seed pre-fork state (mirrors Scenario 1; legacy backend removed).
        await dataSource.transaction(async em => {
            await seedGcrV2(em, [
                { pubkey: "addr_a", balance: 100n },
                { pubkey: "addr_b", balance: 250n },
            ])
            await seedValidators(em, [
                { address: "v_alpha", stakedDem: 5_000n },
            ])
        })

        // Action 1: insert block 10 — migration runs.
        const result10 = await simulateBlockInsertActivationHook(dataSource, 10)
        expect(result10).not.toBeNull()

        const balancesAfterBlock10 = await getGcrV2Balances(dataSource.manager)
        const stakesAfterBlock10 = await getValidatorStakes(dataSource.manager)
        const fsRowAfterBlock10 = await getForkStateRow(dataSource.manager)
        expect(fsRowAfterBlock10!.applied_at_block).toBe(10)

        // Sanity: balances are × 10^9, NOT × 10^18.
        expect(balancesAfterBlock10.get("addr_a")).toBe(100n * 1_000_000_000n)
        expect(balancesAfterBlock10.get("addr_b")).toBe(250n * 1_000_000_000n)

        // Action 2: simulate node restart — DB persists, in-process state
        // discarded. We don't drop the DB; we don't even destroy the
        // DataSource. The "fresh process" feel is captured by re-checking
        // the gate from scratch the way `chainBlocks.insertBlock` would on
        // every block: fork active? applied? then run.
        //
        // For the gate to fire at all on block 11 the fork must still be
        // active (it is — activationHeight is 10). The applied check must
        // short-circuit, leaving everything untouched.
        const result11 = await simulateBlockInsertActivationHook(dataSource, 11)
        expect(result11).toBeNull() // hook short-circuited via applied check

        // fork_state untouched.
        const fsRowAfterBlock11 = await getForkStateRow(dataSource.manager)
        expect(fsRowAfterBlock11!.applied).toBe(1)
        expect(fsRowAfterBlock11!.applied_at_block).toBe(10) // NOT 11
        expect(fsRowAfterBlock11!.pre_sum_dem).toBe(
            fsRowAfterBlock10!.pre_sum_dem,
        )
        expect(fsRowAfterBlock11!.post_sum_os).toBe(
            fsRowAfterBlock10!.post_sum_os,
        )

        // Balances unchanged from after block 10 (i.e. × 10^9, not × 10^18).
        const balancesAfterBlock11 = await getGcrV2Balances(dataSource.manager)
        const stakesAfterBlock11 = await getValidatorStakes(dataSource.manager)

        for (const [pk, postBalance] of balancesAfterBlock10) {
            expect(balancesAfterBlock11.get(pk)).toBe(postBalance)
            // Defensive lower bound: catastrophe would be × 10^18.
            // Compare against a known × 10^18 value to make the failure
            // mode legible if this ever regresses.
            const catastrophe = postBalance * 1_000_000_000n
            expect(balancesAfterBlock11.get(pk)).not.toBe(catastrophe)
        }
        for (const [addr, postStake] of stakesAfterBlock10) {
            expect(stakesAfterBlock11.get(addr)).toBe(postStake)
        }

        // The applied-flag helper agrees from a fresh read.
        expect(
            await isOsDenominationMigrationApplied(dataSource.manager),
        ).toBe(true)
    })
})
