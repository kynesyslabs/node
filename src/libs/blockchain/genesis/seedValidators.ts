/**
 * Genesis validator seeding helper (P6).
 *
 * Seeds the `validators` table from the genesis-baked list in
 * `data/genesis.json`. This function is called from `chainGenesis.ts`
 * inside the same transaction as `restoreSnapshot`, so a failure in
 * either rolls everything back atomically.
 *
 * Genesis-baked validators bypass the normal staking flow entirely —
 * they are inserted directly at status=ACTIVE with staked_amount=1 DEM
 * (1e18). At block 1 the `osDenomination` migration multiplies every
 * `staked_amount` by 10^9, so they end up with 1 OS (1e27).
 */

import type { EntityManager } from "typeorm"

import log from "src/utilities/logger"
import { Validators } from "src/model/entities/Validators"

// Matches `0x` followed by exactly 64 hex characters.
const ADDRESS_RE = /^0x[0-9a-fA-F]{64}$/

export interface GenesisValidatorSeed {
    address: string
    status: string
    connection_url: string | null
    staked_amount: string
    first_seen: number
    valid_at: number
}

/**
 * Validate a single seed row and throw a descriptive error on any
 * problem. All validators are required to have fully-specified fields;
 * partial rows are rejected to avoid silent misconfiguration.
 */
function validateSeed(seed: GenesisValidatorSeed, index: number): void {
    if (!ADDRESS_RE.test(seed.address)) {
        throw new Error(
            `[GENESIS][VALIDATORS] seed[${index}].address invalid: expected 0x + 64 hex chars, got "${seed.address}"`,
        )
    }

    if (typeof seed.status !== "string" || seed.status.length === 0) {
        throw new Error(
            `[GENESIS][VALIDATORS] seed[${index}].status must be a non-empty string`,
        )
    }

    let stakeAsBigInt: bigint
    try {
        stakeAsBigInt = BigInt(seed.staked_amount)
    } catch {
        throw new Error(
            `[GENESIS][VALIDATORS] seed[${index}].staked_amount is not a valid bigint: "${seed.staked_amount}"`,
        )
    }
    if (stakeAsBigInt <= 0n) {
        throw new Error(
            `[GENESIS][VALIDATORS] seed[${index}].staked_amount must be > 0, got "${seed.staked_amount}"`,
        )
    }

    // connection_url must be null or a non-empty string. Reject empty strings
    // and other non-string types (e.g. number, undefined) which would silently
    // store garbage in the validators table.
    if (seed.connection_url !== null) {
        if (typeof seed.connection_url !== "string" || seed.connection_url.length === 0) {
            throw new Error(
                `[GENESIS][VALIDATORS] seed[${index}].connection_url must be null or a non-empty string, got ${JSON.stringify(seed.connection_url)}`,
            )
        }
    }

    if (!Number.isInteger(seed.first_seen) || seed.first_seen < 0) {
        throw new Error(
            `[GENESIS][VALIDATORS] seed[${index}].first_seen must be a non-negative integer, got ${seed.first_seen}`,
        )
    }

    if (!Number.isInteger(seed.valid_at) || seed.valid_at < 0) {
        throw new Error(
            `[GENESIS][VALIDATORS] seed[${index}].valid_at must be a non-negative integer, got ${seed.valid_at}`,
        )
    }
}

/**
 * Seed genesis validators into the `validators` table within the
 * caller-owned transaction.
 *
 * Pre-conditions (enforced):
 *   - `validators` table must be empty. If it has any rows this
 *     function throws so the outer transaction rolls back.
 *
 * Post-conditions:
 *   - Every seed row is inserted exactly once.
 *   - `unstake_requested_at` and `unstake_available_at` are left NULL
 *     (genesis validators are bootstrapped as active, not unstaking).
 *
 * @param em          Caller-owned transactional EntityManager.
 * @param validators  Array of seed objects from `data/genesis.json`.
 * @returns           `{ inserted: N }` where N is the row count.
 */
export async function seedValidators(
    em: EntityManager,
    validators: GenesisValidatorSeed[],
): Promise<{ inserted: number }> {
    if (!Array.isArray(validators) || validators.length === 0) {
        log.info("[GENESIS][VALIDATORS] no validators to seed")
        return { inserted: 0 }
    }

    // Per-row validation — throws immediately on the first offending row.
    validators.forEach((v, i) => validateSeed(v, i))

    // Pre-flight: validators table must be empty at seed time.
    const countRows: Array<{ count: string }> = await em.query(
        `SELECT COUNT(*)::text AS count FROM validators`,
    )
    const existingCount = Number(countRows[0]?.count ?? "0")
    if (!Number.isSafeInteger(existingCount)) {
        throw new Error(
            "[GENESIS][VALIDATORS] preflight: could not count rows in validators table",
        )
    }
    if (existingCount > 0) {
        throw new Error(
            `[GENESIS][VALIDATORS] validator seed requires empty validators table; found ${existingCount} rows`,
        )
    }

    // Build insertion batches. 5 rows at genesis but we cap at 100 to
    // stay within PG's max-parameters limit if the input ever grows.
    const BATCH_SIZE = 100
    let inserted = 0

    for (let i = 0; i < validators.length; i += BATCH_SIZE) {
        const batch = validators.slice(i, i + BATCH_SIZE).map(v => ({
            address: v.address,
            status: v.status,
            connection_url: v.connection_url,
            staked_amount: v.staked_amount,
            first_seen: v.first_seen,
            valid_at: v.valid_at,
            unstake_requested_at: null,
            unstake_available_at: null,
        }))

        await em.insert(Validators, batch)
        inserted += batch.length
    }

    log.info(`[GENESIS][SNAPSHOT] validators: seeded ${inserted}`)

    return { inserted }
}
