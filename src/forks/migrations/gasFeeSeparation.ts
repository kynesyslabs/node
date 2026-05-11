/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

/**
 * DEM-665 — Gas Fee Separation state migration.
 *
 * Creates the two consensus-fixed GCR accounts that the post-fork
 * fee-distribution logic writes to:
 *
 *   1. **Burn address** (`BURN_ADDRESS` = `0x` + 64 zeros) — receives the
 *      burned share of every fee component. Spending FROM this account is
 *      rejected at the GCRBalanceRoutines layer (P8) so the supply
 *      monotonically decreases.
 *   2. **Treasury address** — receives the treasury share of every fee
 *      component. Address is provided at activation time (via the
 *      `gasFeeSeparation` fork payload in `data/genesis.json`).
 *
 * Both accounts are created with balance 0 in the post-fork denomination
 * (OS, since osDenomination must activate at the same height and run
 * first in `chainBlocks.insertBlock` — see ordering note below).
 *
 * Atomicity contract (Q2, same as osDenomination): the caller hands us
 * its block-insert transaction. If either this migration or the block
 * save fails, both roll back together. Idempotent across restarts via
 * the `fork_state` row.
 *
 * Activation ordering inside a single block: osDenomination runs FIRST,
 * then gasFeeSeparation. The hook in `chainBlocks.insertBlock` enforces
 * this order — osDenomination scales every existing balance × 10^9 to
 * OS units, then gasFeeSeparation creates fresh-zero accounts whose
 * balance is already in OS magnitude (0n OS = 0n DEM, so the order
 * doesn't matter for balance values, but it does matter for the
 * documented invariant "all accounts are in OS units after this block").
 */

// REVIEW: DEM-665 — atomic, idempotent state migration. Burn + treasury
// account creation only. No balance touching — that's osDenomination's
// responsibility.

import type { EntityManager } from "typeorm"
import { Referrals } from "@/features/incentive/referrals"
import log from "@/utilities/logger"

/**
 * Public name of this fork. Matches the {@link ForkName} entry registered
 * in `src/forks/forkConfig.ts`. Stored as the primary key in `fork_state`.
 */
export const FORK_NAME = "gasFeeSeparation"

/**
 * Burn-address constant.
 *
 * Re-exported with the same value (deliberate duplicate of the loader's
 * `GAS_FEE_SEPARATION_BURN_ADDRESS`) so both files can compile without a
 * circular import. Authoritative home is here in the migration module —
 * `loadForkConfig.ts` mirrors this value via a `const` and a unit test
 * MUST guard the equality so a future edit can't drift them.
 *
 * Format: lowercase hex, `0x` + 64 zero hex digits = 66 chars total.
 */
export const BURN_ADDRESS = "0x" + "0".repeat(64)

export interface GasFeeSeparationMigrationResult {
    burnAddress: string
    treasuryAddress: string
    burnAccountCreated: boolean
    treasuryAccountCreated: boolean
}

/**
 * SQL placeholder helper, mirrors osDenomination's. Postgres uses `$N`,
 * sqlite uses `?`. Keeps the migration code portable between the
 * production driver and the sqlite-backed test harness.
 */
function placeholder(
    entityManager: EntityManager,
    oneBasedIndex: number,
): string {
    const type = entityManager.connection.options.type
    if (type === "postgres" || type === "cockroachdb") return `$${oneBasedIndex}`
    return "?"
}

/**
 * Returns true iff the gasFeeSeparation migration has already run on this
 * DB. Cheap guard for the block-acceptance hook so it can decide whether
 * to call {@link runGasFeeSeparationMigration} at all.
 */
export async function isGasFeeSeparationMigrationApplied(
    entityManager: EntityManager,
): Promise<boolean> {
    const p1 = placeholder(entityManager, 1)
    const rows: Array<{ applied: boolean | number | string }> =
        await entityManager.query(
            `SELECT applied FROM fork_state WHERE fork_name = ${p1}`,
            [FORK_NAME],
        )
    if (!rows || rows.length === 0) return false
    const applied = rows[0].applied
    return applied === true || applied === 1 || applied === "1" || applied === "t"
}

/**
 * Build the JSONB-serialised payload for a zero-balance account.
 *
 * Stays in plain-object territory so callers can `JSON.stringify` it for
 * sqlite (TEXT) test schemas or pass the structure straight through to
 * Postgres' JSONB binding.
 */
function buildDefaultAccountFields(pubkey: string): {
    assignedTxs: string
    nonce: number
    balance: string
    identities: string
    points: string
    referralInfo: string
    flagged: number | boolean
    flaggedReason: string
    reviewed: number | boolean
} {
    return {
        assignedTxs: JSON.stringify([]),
        nonce: 0,
        balance: "0",
        identities: JSON.stringify({ xm: {}, web2: {}, pqc: {}, ud: [] }),
        points: JSON.stringify({
            totalPoints: 0,
            breakdown: {
                web3Wallets: {},
                socialAccounts: {
                    twitter: 0,
                    github: 0,
                    discord: 0,
                    telegram: 0,
                },
                referrals: 0,
                demosFollow: 0,
                nomisScores: {},
            },
            lastUpdated: new Date().toISOString(),
        }),
        referralInfo: JSON.stringify({
            totalReferrals: 0,
            referralCode: Referrals.generateReferralCode(pubkey),
            referrals: [],
            referredBy: null,
        }),
        flagged: 0,
        flaggedReason: "",
        reviewed: 0,
    }
}

/**
 * Idempotent create: if a row exists at `pubkey`, do nothing and return
 * `false`. Otherwise raw-INSERT into `gcr_main` using the caller's
 * `EntityManager`. Raw SQL (rather than `.getRepository(GCRMain).save`)
 * keeps the migration portable between Postgres production and the
 * sqlite-backed test harness — same approach as `osDenomination` for the
 * same reason.
 *
 * Pre-existence is treated as success rather than a hard error so the
 * migration is forgiving of operators who manually pre-seeded burn /
 * treasury in genesis (the legacy hand-edited approach).
 */
async function ensureZeroAccount(
    entityManager: EntityManager,
    pubkey: string,
): Promise<boolean> {
    const p1 = placeholder(entityManager, 1)
    const existing: Array<{ pubkey: string; balance: string }> =
        await entityManager.query(
            `SELECT pubkey, balance FROM gcr_main WHERE pubkey = ${p1}`,
            [pubkey],
        )
    if (existing && existing.length > 0) {
        log.info(
            `[forks][gasFeeSeparation] account already present at ${pubkey} ` +
                `— leaving untouched (balance=${existing[0].balance})`,
        )
        return false
    }

    const fields = buildDefaultAccountFields(pubkey)
    const isPg =
        entityManager.connection.options.type === "postgres" ||
        entityManager.connection.options.type === "cockroachdb"

    // Postgres jsonb / sqlite text: in both cases we hand the driver the
    // canonical JSON string; Postgres' binding implicitly casts a string
    // to jsonb when the target column is jsonb. Timestamps are bound as
    // ISO strings (same trick as osDenomination's fork_state UPSERT).
    const nowIso = new Date().toISOString()
    const ph = (i: number) => placeholder(entityManager, i)
    const flaggedValue: boolean | number = isPg ? false : 0
    const reviewedValue: boolean | number = isPg ? false : 0
    await entityManager.query(
        `INSERT INTO gcr_main (
            pubkey, "assignedTxs", nonce, balance, identities,
            points, "referralInfo", flagged, "flaggedReason",
            reviewed, "createdAt", "updatedAt"
        ) VALUES (${ph(1)}, ${ph(2)}, ${ph(3)}, ${ph(4)}, ${ph(5)}, ${ph(6)}, ${ph(7)}, ${ph(8)}, ${ph(9)}, ${ph(10)}, ${ph(11)}, ${ph(12)})`,
        [
            pubkey,
            fields.assignedTxs,
            fields.nonce,
            fields.balance,
            fields.identities,
            fields.points,
            fields.referralInfo,
            flaggedValue,
            fields.flaggedReason,
            reviewedValue,
            nowIso,
            nowIso,
        ],
    )
    log.info(
        `[forks][gasFeeSeparation] created account at ${pubkey} with balance=0`,
    )
    return true
}

/**
 * Runs the gasFeeSeparation state migration end-to-end. Idempotent.
 *
 * MUST be called from inside an existing TypeORM transaction. The caller
 * is responsible for opening that transaction (e.g. via
 * `dataSource.transaction(em => runGasFeeSeparationMigration(em, ...))`
 * or by passing the `transactionalEntityManager` from an existing
 * `dataSource.transaction()` block).
 *
 * On any error this function throws; the outer transaction must roll back
 * so that no partial migration is observable.
 *
 * @param entityManager Caller-owned transactional entity manager.
 * @param blockNumber The block height at which the migration is being
 *   activated. Stored in `fork_state.applied_at_block` as a forensic
 *   marker.
 * @param treasuryAddress Lowercase hex `0x` + 64 hex chars treasury
 *   address from the `gasFeeSeparation` fork payload. Validated upstream
 *   by `loadForkConfig.ts` — re-validated lightly here as defence in
 *   depth.
 *
 * @throws if the migration is already applied (defense-in-depth — caller
 *   should normally guard with {@link isGasFeeSeparationMigrationApplied}).
 * @throws if `treasuryAddress` is malformed or equals `BURN_ADDRESS`.
 */
export async function runGasFeeSeparationMigration(
    entityManager: EntityManager,
    blockNumber: number,
    treasuryAddress: string,
): Promise<GasFeeSeparationMigrationResult> {
    log.info(
        `[forks][gasFeeSeparation] starting state migration at block ${blockNumber}`,
    )

    // 1. Idempotency guard.
    if (await isGasFeeSeparationMigrationApplied(entityManager)) {
        throw new Error(
            `gasFeeSeparation migration already applied at block ${blockNumber}`,
        )
    }

    // 2. Defence-in-depth address validation. The loader already enforced
    //    the format; we re-check here so a future code path that bypasses
    //    the loader (e.g. direct test invocation) still fails closed.
    if (
        typeof treasuryAddress !== "string" ||
        !/^0x[0-9a-f]{64}$/.test(treasuryAddress)
    ) {
        throw new Error(
            `[forks][gasFeeSeparation] treasuryAddress must match /^0x[0-9a-f]{64}$/, got: ${JSON.stringify(
                treasuryAddress,
            )}`,
        )
    }
    if (treasuryAddress === BURN_ADDRESS) {
        throw new Error(
            "[forks][gasFeeSeparation] treasuryAddress equals BURN_ADDRESS — refusing to route fees into the burn account (placeholder must be replaced before sealing genesis).",
        )
    }

    // 3. Create burn account (balance 0).
    const burnAccountCreated = await ensureZeroAccount(
        entityManager,
        BURN_ADDRESS,
    )

    // 4. Create treasury account (balance 0).
    const treasuryAccountCreated = await ensureZeroAccount(
        entityManager,
        treasuryAddress,
    )

    // 5. Persist `fork_state` row (UPSERT). Reuses the columns introduced
    //    for osDenomination — most of them are NULL here because this
    //    migration doesn't touch balances. Only `applied`, `applied_at_block`
    //    and `applied_at` carry meaning. We still UPSERT for symmetry
    //    with the osDenomination flow.
    const isPg =
        entityManager.connection.options.type === "postgres" ||
        entityManager.connection.options.type === "cockroachdb"
    const appliedValue: boolean | number = isPg ? true : 1
    const appliedAtValue: string = new Date().toISOString()
    const ph = (i: number) => placeholder(entityManager, i)
    await entityManager.query(
        `INSERT INTO fork_state (
            fork_name, applied, applied_at_block, applied_at
        ) VALUES (${ph(1)}, ${ph(2)}, ${ph(3)}, ${ph(4)})
        ON CONFLICT (fork_name) DO UPDATE SET
            applied = EXCLUDED.applied,
            applied_at_block = EXCLUDED.applied_at_block,
            applied_at = EXCLUDED.applied_at`,
        [FORK_NAME, appliedValue, blockNumber, appliedAtValue],
    )

    log.info(
        `[forks][gasFeeSeparation] fork_state row persisted; burn=${BURN_ADDRESS}, treasury=${treasuryAddress}, burnCreated=${burnAccountCreated}, treasuryCreated=${treasuryAccountCreated}`,
    )

    return {
        burnAddress: BURN_ADDRESS,
        treasuryAddress,
        burnAccountCreated,
        treasuryAccountCreated,
    }
}
