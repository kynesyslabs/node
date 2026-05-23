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
import { runOsDenominationMigration } from "src/forks/migrations/osDenomination"
import { runGasFeeSeparationMigration } from "src/forks/migrations/gasFeeSeparation"
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
 */
export async function applyForksAtGenesis(
    em: EntityManager,
    forks: GenesisForkConfig | undefined,
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
    // Pre-apply unconditionally when the forks block is present in genesis.
    // The snapshot ships pre-fork (DEM) values; the migration's job is to
    // upgrade them in-place. activationHeight in genesis.json is left at 0
    // (= "applied at genesis"); the block-N hook in chainBlocks.ts is
    // already a no-op for height<=0 AND the migration's own idempotency
    // guard prevents double-application either way.
    if (forks.osDenomination) {
        log.info("[GENESIS][FORKS] pre-applying osDenomination at block 0")
        await runOsDenominationMigration(em, 0)
        osDenominationApplied = true
    }

    // --- 2. gasFeeSeparation -------------------------------------------------
    // gasFeeSeparation creates burn + treasury accounts in OS units.
    // Must run after osDenomination so the documented ordering invariant holds.
    if (forks.gasFeeSeparation) {
        log.info("[GENESIS][FORKS] pre-applying gasFeeSeparation at block 0")
        await runGasFeeSeparationMigration(
            em,
            0,
            forks.gasFeeSeparation.treasuryAddress,
        )
        gasFeeSeparationApplied = true
    }

    const elapsed_ms = Date.now() - t0

    log.info(
        `[GENESIS][FORKS] pre-apply complete: osDenomination=${osDenominationApplied} ` +
            `gasFeeSeparation=${gasFeeSeparationApplied} elapsed=${elapsed_ms}ms`,
    )

    return { osDenominationApplied, gasFeeSeparationApplied, elapsed_ms }
}
