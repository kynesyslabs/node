/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

/**
 * P3b — DEM → OS state migration.
 *
 * Multiplies every account balance and validator stake by 10^9 in a single
 * atomic operation, idempotent across restarts via the `fork_state` table.
 *
 * Three balance-bearing sources are migrated:
 *
 *  1. **GCRv2 `gcr_main.balance`** (`bigint`) — single UPDATE × 10^9.
 *  2. **`validators.staked_amount`** (`text`, bigint-as-string) — single
 *     UPDATE that multiplies the cast numeric × 10^9.
 *
 * The migration runs **inside the caller-provided EntityManager**. This is
 * how Q2's atomicity contract is honored: caller hands us its block-insert
 * transaction; if either the migration or the block save fails, both roll
 * back together.
 *
 * Sum invariant (cap-aware):
 *
 *   postSumOs == preSumDem * 10^9 - totalValueLostOs
 *
 * The migration aborts (throws) if this equation does not hold post-update,
 * which forces the outer transaction to roll back.
 */

// REVIEW: P3b — atomic, idempotent state migration with CAP policy.

import type { EntityManager } from "typeorm"
import log from "@/utilities/logger"

/**
 * Cap value for legacy GCR balances that would exceed JS number precision
 * after multiplication by 10^9. Computed once.
 *
 * Math.floor(Number.MAX_SAFE_INTEGER * 0.9) === 8106479329266892
 *
 * Stored as a `bigint` so cap comparisons stay precise and value-loss math
 * doesn't drop into Number territory.
 */
export const LEGACY_NUMBER_CAP = BigInt(
    Math.floor(Number.MAX_SAFE_INTEGER * 0.9),
)

/**
 * Multiplier applied to every DEM balance to convert to OS. 1 DEM = 10^9 OS.
 */
const OS_PER_DEM = 1_000_000_000n

/**
 * Public name of this fork. Matches the {@link ForkName} entry registered
 * in `src/forks/forkConfig.ts`. Stored as the primary key in `fork_state`.
 */
export const FORK_NAME = "osDenomination"

export interface OsDenominationMigrationResult {
    preSumDem: bigint
    postSumOs: bigint
    gcrV2RowCount: number
    legacyRowCount: number
    validatorsRowCount: number
    cappedCount: number
    totalValueLostOs: bigint
    /**
     * Number of validator rows that could not be parsed as a `bigint`
     * (e.g. malformed `staked_amount` text such as empty string, whitespace,
     * non-numeric). These rows are SKIPPED — their `staked_amount` is left
     * untouched and they are excluded from both the pre- and post-sum so
     * the invariant remains valid.
     *
     * This counter is persisted into `fork_state.malformed_validators_count`
     * for forensic auditing.
     */
    malformedValidatorsCount: number
}

/**
 * Renders a positional parameter placeholder for the SQL dialect of the
 * provided EntityManager. Postgres uses `$1, $2, …`; sqlite uses `?`. This
 * keeps the migration code portable between the production driver and the
 * sqlite-backed test harness.
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
 * Returns true iff the osDenomination migration has already run on this DB.
 *
 * Cheap helper for the block-acceptance hook so it can decide whether to
 * call {@link runOsDenominationMigration} at all. Reads the persistent
 * `fork_state` row written by a successful migration.
 *
 * @param entityManager TypeORM entity manager (transactional or root).
 * @returns `true` if `fork_state.applied = true` for `osDenomination`.
 */
export async function isOsDenominationMigrationApplied(
    entityManager: EntityManager,
): Promise<boolean> {
    const p1 = placeholder(entityManager, 1)
    const rows: Array<{ applied: boolean | number | string }> =
        await entityManager.query(
            `SELECT applied FROM fork_state WHERE fork_name = ${p1}`,
            [FORK_NAME],
        )
    if (!rows || rows.length === 0) return false
    // Postgres returns boolean; sqlite returns 0/1. Normalize.
    const applied = rows[0].applied
    return applied === true || applied === 1 || applied === "1" || applied === "t"
}

/**
 * Returns a parsed `bigint` for a validator row's `staked_amount`, or `null`
 * if the value is missing or malformed (empty string, whitespace, non-numeric
 * text). Wraps `BigInt()` in try/catch so a single poison row cannot abort
 * the whole migration with an unhelpful SyntaxError.
 *
 * Caller decides what to do with `null`: the sum-helpers SKIP the row (it
 * contributes nothing to either the pre- or post-sum), while the migration
 * loop also SKIPS it but increments a forensic counter so the operator knows
 * how many rows were left untouched.
 *
 * @internal Exported for test access.
 */
export function tryParseValidatorStake(
    raw: string | null | undefined,
): bigint | null {
    if (raw === null || raw === undefined) return null
    if (typeof raw !== "string") {
        // Some drivers may hand back numbers; coerce safely.
        try {
            return BigInt(raw as never)
        } catch {
            return null
        }
    }
    const trimmed = raw.trim()
    if (trimmed === "") return null
    try {
        return BigInt(trimmed)
    } catch {
        return null
    }
}

/**
 * Sums all balances across the three sources in their pre-fork (DEM) units.
 *
 * Uses `bigint` everywhere; never trusts JS number arithmetic on legacy
 * balances — they are summed by parsing each row's number value via
 * `BigInt(Math.trunc(...))`. This is safe for legacy balances ≤ 2^53-1
 * (which is the implicit invariant for them existing in the JSONB column
 * at all).
 *
 * Validator rows whose `staked_amount` cannot be parsed as a `bigint`
 * (empty/whitespace/non-numeric) are SKIPPED — they contribute nothing to
 * the sum. This must mirror the migration loop's behavior so the post-sum
 * invariant remains valid in the presence of malformed rows.
 *
 * @internal Exported for test access.
 */
export async function computePreSumDem(
    entityManager: EntityManager,
): Promise<{
    sum: bigint
    gcrV2RowCount: number
    legacyRowCount: number
    validatorsRowCount: number
}> {
    let sum = 0n
    let gcrV2RowCount = 0
    const legacyRowCount = 0
    let validatorsRowCount = 0

    // GCRv2 — bigint column. Rows where balance is null are tolerated as 0.
    const gcrV2Rows: Array<{ balance: string | bigint | null }> =
        await entityManager.query("SELECT balance FROM gcr_main")
    for (const row of gcrV2Rows) {
        gcrV2RowCount += 1
        if (row.balance === null || row.balance === undefined) continue
        sum += toBigInt(row.balance)
    }

    // Validators stake — text bigint-as-string. Malformed rows are skipped
    // so the post-sum invariant remains valid.
    const validatorRows: Array<{ staked_amount: string | null }> =
        await entityManager.query(
            "SELECT staked_amount FROM validators",
        )
    for (const row of validatorRows) {
        validatorsRowCount += 1
        const parsed = tryParseValidatorStake(row.staked_amount)
        if (parsed === null) continue
        sum += parsed
    }

    return { sum, gcrV2RowCount, legacyRowCount, validatorsRowCount }
}

/**
 * Sums all balances across the three sources in their post-fork (OS) units.
 *
 * Identical shape to {@link computePreSumDem}; the difference is that we
 * expect every legacy row's `balance` to either be the cap value or a
 * sub-cap OS integer.
 *
 * @internal Exported for test access.
 */
export async function computePostSumOs(
    entityManager: EntityManager,
): Promise<bigint> {
    let sum = 0n

    const gcrV2Rows: Array<{ balance: string | bigint | null }> =
        await entityManager.query("SELECT balance FROM gcr_main")
    for (const row of gcrV2Rows) {
        if (row.balance === null || row.balance === undefined) continue
        sum += toBigInt(row.balance)
    }

    const validatorRows: Array<{ staked_amount: string | null }> =
        await entityManager.query("SELECT staked_amount FROM validators")
    for (const row of validatorRows) {
        // Mirror computePreSumDem: skip malformed/null staked_amounts so the
        // sum-invariant comparison stays apples-to-apples.
        const parsed = tryParseValidatorStake(row.staked_amount)
        if (parsed === null) continue
        sum += parsed
    }

    return sum
}

/**
 * Runs the DEM → OS state migration end-to-end. Idempotent.
 *
 * MUST be called from inside an existing TypeORM transaction. The caller
 * is responsible for opening that transaction (e.g. via
 * `dataSource.transaction(em => runOsDenominationMigration(em, ...))` or by
 * passing the `transactionalEntityManager` from an existing
 * `dataSource.transaction()` block).
 *
 * On any error this function throws; the outer transaction must roll back
 * so that no partial migration is observable.
 *
 * @param entityManager Caller-owned transactional entity manager.
 * @param blockNumber The block height at which the migration is being
 *   activated. Stored in `fork_state.applied_at_block` as a forensic
 *   marker.
 *
 * @throws if the migration is already applied (defense-in-depth — caller
 *   should normally guard with {@link isOsDenominationMigrationApplied}).
 * @throws if the sum invariant fails after applying all updates.
 */
export async function runOsDenominationMigration(
    entityManager: EntityManager,
    blockNumber: number,
): Promise<OsDenominationMigrationResult> {
    log.info(
        `[forks][osDenomination] starting state migration at block ${blockNumber}`,
    )

    // 1. Idempotency guard.
    if (await isOsDenominationMigrationApplied(entityManager)) {
        throw new Error(
            `osDenomination migration already applied at block ${blockNumber}`,
        )
    }

    // 2. Compute pre-sum (DEM) and per-table row counts.
    const { sum: preSumDem, gcrV2RowCount, legacyRowCount, validatorsRowCount } =
        await computePreSumDem(entityManager)
    log.info(
        `[forks][osDenomination] preSumDem=${preSumDem.toString()} ` +
            `gcrV2Rows=${gcrV2RowCount} legacyRows=${legacyRowCount} ` +
            `validatorsRows=${validatorsRowCount}`,
    )

    // 3. Migrate GCRv2 — single bulk UPDATE.
    await entityManager.query(
        "UPDATE gcr_main SET balance = balance * 1000000000",
    )
    log.info(
        `[forks][osDenomination] gcr_main migrated (rows=${gcrV2RowCount})`,
    )

    const cappedCount = 0
    const totalValueLostOs = 0n
    // 5. Migrate Validators stake — single bulk UPDATE that handles '0'
    // and any valid bigint string. We use raw SQL with a portable pattern:
    // the cast-as-text/cast-as-numeric round-trip is supported by both
    // Postgres and Bun's bundled sqlite (via implicit numeric promotion).
    //
    // Implementation note: instead of multi-step CAST AS numeric we read &
    // write each row individually for portability with sqlite's strict
    // text columns. Cost is one round-trip per validator; fine since the
    // validator set is bounded.
    const validatorRows: Array<{ address: string; staked_amount: string | null }> =
        await entityManager.query(
            "SELECT address, staked_amount FROM validators",
        )
    let malformedValidatorsCount = 0
    for (const row of validatorRows) {
        if (row.staked_amount === null || row.staked_amount === undefined) {
            // Null is a tolerated shape (matches sum-helpers).
            continue
        }
        // DEFENSIVE: a single poison row in `validators.staked_amount` (empty
        // string, whitespace, alphanumeric) used to raise SyntaxError out of
        // `BigInt()`, propagate through `runOsDenominationMigration` →
        // `insertBlock`, and abort the activation block on every node
        // permanently — meaning the fork could never activate. Wrap the
        // per-row coercion + UPDATE so a malformed value is logged loudly,
        // counted, and skipped (its `staked_amount` is left untouched). The
        // sum-helpers above also skip the same shape so the post-sum
        // invariant remains valid.
        const parsed = tryParseValidatorStake(row.staked_amount)
        if (parsed === null) {
            malformedValidatorsCount += 1
            log.error(
                "[forks][osDenomination] MALFORMED validator stake — " +
                    `address=${row.address} ` +
                    `raw=${JSON.stringify(row.staked_amount)} ` +
                    "skipping row (staked_amount left unchanged)",
            )
            continue
        }
        const newStake = (parsed * OS_PER_DEM).toString()
        const pStake = placeholder(entityManager, 1)
        const pAddr = placeholder(entityManager, 2)
        await entityManager.query(
            `UPDATE validators SET staked_amount = ${pStake} WHERE address = ${pAddr}`,
            [newStake, row.address],
        )
    }
    log.info(
        `[forks][osDenomination] validators migrated (rows=${validatorsRowCount}, ` +
            `malformed=${malformedValidatorsCount})`,
    )

    // 6. Compute post-sum.
    const postSumOs = await computePostSumOs(entityManager)
    log.info(
        `[forks][osDenomination] postSumOs=${postSumOs.toString()}`,
    )

    // 7. Sum invariant.
    const expectedPostSumOs = preSumDem * OS_PER_DEM - totalValueLostOs
    if (postSumOs !== expectedPostSumOs) {
        throw new Error(
            "[forks][osDenomination] sum invariant violated: " +
                `expected postSumOs=${expectedPostSumOs.toString()} ` +
                `(preSumDem=${preSumDem.toString()} * 10^9 - ` +
                `valueLostOs=${totalValueLostOs.toString()}), ` +
                `actual=${postSumOs.toString()}`,
        )
    }
    log.info(
        "[forks][osDenomination] sum invariant verified: " +
            "postSumOs == preSumDem * 10^9 - valueLostOs",
    )

    // 8. Persist `fork_state` row (UPSERT).
    // SQLite stores booleans as 0/1; some drivers don't auto-coerce JS
    // booleans for sqlite, so pass an integer literal for portability.
    const isPg =
        entityManager.connection.options.type === "postgres" ||
        entityManager.connection.options.type === "cockroachdb"
    const appliedValue: boolean | number = isPg ? true : 1
    // Postgres' driver doesn't reliably bind JS Date as `timestamp`; use ISO.
    const appliedAtValue: string = new Date().toISOString()
    const ph = (i: number) => placeholder(entityManager, i)
    await entityManager.query(
        `INSERT INTO fork_state (
            fork_name, applied, applied_at_block, applied_at,
            pre_sum_dem, post_sum_os,
            gcr_v2_row_count, legacy_row_count, validators_row_count,
            capped_count, total_value_lost_os,
            malformed_validators_count
        ) VALUES (${ph(1)}, ${ph(2)}, ${ph(3)}, ${ph(4)}, ${ph(5)}, ${ph(6)}, ${ph(7)}, ${ph(8)}, ${ph(9)}, ${ph(10)}, ${ph(11)}, ${ph(12)})
        ON CONFLICT (fork_name) DO UPDATE SET
            applied = EXCLUDED.applied,
            applied_at_block = EXCLUDED.applied_at_block,
            applied_at = EXCLUDED.applied_at,
            pre_sum_dem = EXCLUDED.pre_sum_dem,
            post_sum_os = EXCLUDED.post_sum_os,
            gcr_v2_row_count = EXCLUDED.gcr_v2_row_count,
            legacy_row_count = EXCLUDED.legacy_row_count,
            validators_row_count = EXCLUDED.validators_row_count,
            capped_count = EXCLUDED.capped_count,
            total_value_lost_os = EXCLUDED.total_value_lost_os,
            malformed_validators_count = EXCLUDED.malformed_validators_count`,
        [
            FORK_NAME,
            appliedValue,
            blockNumber,
            appliedAtValue,
            preSumDem.toString(),
            postSumOs.toString(),
            gcrV2RowCount,
            legacyRowCount,
            validatorsRowCount,
            cappedCount,
            totalValueLostOs.toString(),
            malformedValidatorsCount,
        ],
    )
    log.info(
        "[forks][osDenomination] fork_state row persisted; migration complete",
    )

    return {
        preSumDem,
        postSumOs,
        gcrV2RowCount,
        legacyRowCount,
        validatorsRowCount,
        cappedCount,
        totalValueLostOs,
        malformedValidatorsCount,
    }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Coerces whatever the underlying driver returns for a `bigint` column into
 * a real JS `bigint`. Postgres' `pg` driver returns strings for `bigint`;
 * sqlite returns numbers. Both are safe to feed into `BigInt(...)`.
 */
function toBigInt(value: string | bigint | number): bigint {
    if (typeof value === "bigint") return value
    return BigInt(value)
}

/**
 * Parses the legacy GCR's `details` JSONB column into a plain object.
 *
 * Postgres' driver returns `details` already-parsed. SQLite returns it as
 * a TEXT string. Both code paths must work for the test harness to be
 * portable.
 */
function parseLegacyDetails(
    details: unknown,
): { content: { balance: number; [k: string]: unknown }; [k: string]: unknown } | null {
    if (details === null || details === undefined) return null
    if (typeof details === "string") {
        try {
            return JSON.parse(details)
        } catch {
            return null
        }
    }
    if (typeof details === "object") {
        return details as ReturnType<typeof parseLegacyDetails>
    }
    return null
}

/**
 * Reads only `details.content.balance` for sum calculations. Tolerates a
 * legacy backend that may have a row with no `content` block at all.
 */
function readLegacyBalance(details: unknown): number | null {
    const parsed = parseLegacyDetails(details)
    const balance = parsed?.content?.balance
    if (typeof balance !== "number" || !isFinite(balance)) return null
    return balance
}

/**
 * Re-serializes the legacy `details` payload for parameter binding.
 *
 * Both Postgres (`pg` driver) and sqlite accept a JSON-stringified value
 * for a `jsonb`/text column when bound as a parameter — Postgres parses
 * the string at the column boundary, sqlite stores the raw text. The
 * `original` argument is kept as a sanity hook in case future drivers
 * need a different binding shape.
 */
function serializeLegacyDetails(
    obj: Record<string, unknown>,
    _original: unknown,
): string {
    return JSON.stringify(obj)
}

/**
 * Best-effort label for log lines when an account is capped. Falls back
 * to a placeholder when the legacy row lacks an obvious identity field.
 */
function getLegacyAccountTag(parsed: Record<string, unknown>): string {
    const content = parsed?.content as Record<string, unknown> | undefined
    const identities = content?.identities as Record<string, unknown> | undefined
    if (identities && typeof identities === "object") {
        // Pick the first key as a stable tag for forensic logs.
        const firstKey = Object.keys(identities)[0]
        if (firstKey) return `identity:${firstKey}`
    }
    return "<unknown>"
}
