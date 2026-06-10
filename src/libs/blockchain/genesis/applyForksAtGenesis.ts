/**
 * P7 — Pre-apply forks deterministically at genesis-time.
 *
 * Migrations are pure functions of input state. Running them inside the
 * snapshot-restore transaction (block 0) produces the same output as
 * running them at block 1 via the chainBlocks hook — but without needing
 * consensus quorum to produce that block. A solo node with 20% stake can
 * boot fully post-fork on a fresh DB immediately.
 *
 * Ordering: osDenomination first, gasFeeSeparation second. gasFeeSeparation
 * creates burn/treasury accounts at balance 0; since 0 OS == 0 DEM the
 * ordering is safe for balance values, and the documented invariant
 * "all accounts are in OS units after osDenomination" is preserved.
 *
 * The caller (chainGenesis.ts) invokes this inside the same TypeORM
 * transaction that holds restoreSnapshot + seedValidators, so a failure in
 * any migration rolls back the entire genesis atomically.
 *
 * When data/genesis.json has activationHeight=null for a fork, the
 * chainBlocks.ts block-N hook sees isForkActive(...) === false and skips.
 * The fork_state row written here is the durable "applied" record.
 * Two layers of defence: null height + idempotency guard both prevent
 * double-application.
 */

import type { EntityManager } from "typeorm"
import {
    runOsDenominationMigration,
    FORK_NAME as OS_FORK_NAME,
} from "src/forks/migrations/osDenomination"
import {
    runGasFeeSeparationMigration,
    FORK_NAME as GAS_FORK_NAME,
} from "src/forks/migrations/gasFeeSeparation"
import type { ForkStateEntry } from "src/libs/blockchain/genesis/verifySnapshot"
import log from "src/utilities/logger"

export interface GenesisForkConfig {
    osDenomination: { activationHeight: number | null }
    gasFeeSeparation: {
        activationHeight: number | null
        treasuryAddress: string
    }
}

export interface ApplyForksReport {
    osDenominationApplied: boolean
    gasFeeSeparationApplied: boolean
    elapsed_ms: number
}

/**
 * Pre-apply osDenomination and gasFeeSeparation inside the caller's
 * genesis transaction (block 0). Returns a report of what was applied.
 *
 * The function is a pure orchestrator: it delegates to the existing
 * migration functions without touching their internals. Each migration is
 * independently idempotent via the `fork_state` table — if this function
 * is somehow called twice (e.g. test harness re-use), the second call
 * throws from the migration's own guard and propagates to the caller.
 *
 * @param em Caller-owned transactional EntityManager. Must already be
 *   inside an active TypeORM transaction.
 * @param forks The `forks` block from `genesisData` (may be undefined/null
 *   for legacy dev-chain genesis files that carry no fork config).
 * @param snapshotForkState Optional `fork_state` rows carried in the snapshot
 *   manifest (schemaVersion 2). When a fork is marked `applied` there, the
 *   snapshot data is ALREADY in that fork's target units — so we seed the
 *   fork_state marker row and SKIP the migration rather than re-applying it
 *   (which, for osDenomination, would multiply balances by 1e9 a second
 *   time). Absent/false → run the migration as before (pre-fork snapshot).
 */
export async function applyForksAtGenesis(
    em: EntityManager,
    forks: GenesisForkConfig | undefined,
    snapshotForkState?: ForkStateEntry[],
): Promise<ApplyForksReport> {
    const t0 = Date.now()

    if (!forks || typeof forks !== "object") {
        log.info(
            "[GENESIS][FORKS] no forks block in genesis.json; nothing to pre-apply",
        )
        return {
            osDenominationApplied: false,
            gasFeeSeparationApplied: false,
            elapsed_ms: 0,
        }
    }

    let osDenominationApplied = false
    let gasFeeSeparationApplied = false

    // --- 1. osDenomination ---------------------------------------------------
    // Pre-apply when the forks block is present in genesis. A pre-fork (DEM)
    // snapshot has the migration RUN here to upgrade balances in-place. A
    // post-fork (OS) snapshot already carries OS values + an `applied`
    // fork_state row in its manifest — for that case we seed the marker and
    // SKIP the migration so balances are not multiplied by 1e9 a second time.
    if (forks.osDenomination) {
        const pre = findForkState(snapshotForkState, OS_FORK_NAME)
        if (pre?.applied) {
            log.info(
                "[GENESIS][FORKS] osDenomination already applied in snapshot; seeding fork_state, skipping migration",
            )
            await seedForkStateRow(em, pre)
        } else {
            log.info("[GENESIS][FORKS] pre-applying osDenomination at block 0")
            await runOsDenominationMigration(em, 0)
        }
        osDenominationApplied = true
    }

    // --- 2. gasFeeSeparation -------------------------------------------------
    // gasFeeSeparation creates burn + treasury accounts in OS units.
    // Must run after osDenomination so the documented ordering invariant holds.
    // Same pre/post-fork handling as osDenomination.
    if (forks.gasFeeSeparation) {
        const pre = findForkState(snapshotForkState, GAS_FORK_NAME)
        if (pre?.applied) {
            log.info(
                "[GENESIS][FORKS] gasFeeSeparation already applied in snapshot; seeding fork_state, skipping migration",
            )
            await seedForkStateRow(em, pre)
        } else {
            log.info("[GENESIS][FORKS] pre-applying gasFeeSeparation at block 0")
            await runGasFeeSeparationMigration(
                em,
                0,
                forks.gasFeeSeparation.treasuryAddress,
            )
        }
        gasFeeSeparationApplied = true
    }

    const elapsed_ms = Date.now() - t0

    log.info(
        `[GENESIS][FORKS] pre-apply complete: osDenomination=${osDenominationApplied} ` +
            `gasFeeSeparation=${gasFeeSeparationApplied} elapsed=${elapsed_ms}ms`,
    )

    return { osDenominationApplied, gasFeeSeparationApplied, elapsed_ms }
}

function findForkState(
    forkState: ForkStateEntry[] | undefined,
    forkName: string,
): ForkStateEntry | undefined {
    if (!Array.isArray(forkState)) return undefined
    return forkState.find(f => f.fork_name === forkName)
}

/**
 * Render a positional parameter placeholder for the EntityManager's SQL
 * dialect ($1.. for Postgres, ? for sqlite). Mirrors the helper in the
 * migration modules so this code is portable to the sqlite test harness.
 */
function placeholder(em: EntityManager, oneBasedIndex: number): string {
    const type = em.connection.options.type
    if (type === "postgres" || type === "cockroachdb") return `$${oneBasedIndex}`
    return "?"
}

/**
 * Seed a `fork_state` row verbatim from a snapshot manifest entry. Used when a
 * fork is already applied in the snapshot data: we record the durable marker
 * (so {@link isOsDenominationMigrationApplied}-style guards see it) WITHOUT
 * re-running the migration. Raw parameterized SQL keeps it portable across
 * Postgres and the sqlite test harness; `applied` is bound as a boolean on
 * Postgres and 0/1 on sqlite.
 */
async function seedForkStateRow(
    em: EntityManager,
    entry: ForkStateEntry,
): Promise<void> {
    const isPg =
        em.connection.options.type === "postgres" ||
        em.connection.options.type === "cockroachdb"
    const appliedValue: boolean | number = isPg
        ? !!entry.applied
        : entry.applied
          ? 1
          : 0
    const ph = (i: number) => placeholder(em, i)
    await em.query(
        `INSERT INTO fork_state (
            fork_name, applied, applied_at_block, applied_at,
            pre_sum_dem, post_sum_os,
            gcr_v2_row_count, legacy_row_count, validators_row_count,
            capped_count, total_value_lost_os,
            malformed_validators_count
        ) VALUES (${ph(1)}, ${ph(2)}, ${ph(3)}, ${ph(4)}, ${ph(5)}, ${ph(6)}, ${ph(7)}, ${ph(8)}, ${ph(9)}, ${ph(10)}, ${ph(11)}, ${ph(12)})`,
        [
            entry.fork_name,
            appliedValue,
            entry.applied_at_block ?? null,
            entry.applied_at ?? null,
            entry.pre_sum_dem ?? null,
            entry.post_sum_os ?? null,
            entry.gcr_v2_row_count ?? null,
            entry.legacy_row_count ?? null,
            entry.validators_row_count ?? null,
            entry.capped_count ?? null,
            entry.total_value_lost_os ?? null,
            entry.malformed_validators_count ?? null,
        ],
    )
}
