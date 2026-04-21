/**
 * Phase-0 staking constants.
 *
 * These are kept non-governable in Phase 0. Phase 1 (stackable-genesis) will
 * expose some of them via NetworkParameters once the governance system lands.
 */

/** Blocks a validator must wait after requesting unstake before they may exit.
 *  Plan doc `staking_research/plan/plan.md` §0.2.3 pins this at 1000, ≈10x
 *  voting window, to make vote-and-run economically unattractive.
 */
export const UNSTAKE_LOCK_BLOCKS = 1000

/** Status codes we write into Validators.status. */
export const VALIDATOR_STATUS_ACTIVE = "2"
export const VALIDATOR_STATUS_UNSTAKING = "3" // unstake requested, still active
export const VALIDATOR_STATUS_EXITED = "0"

/** Default minimum stake (bigint-as-string, 10M DEM with 18 decimals).
 *  Matches the legacy hardcoded `minToStake` in validatorsManagement.ts.
 *  Phase 1 governance will replace this with a dynamic value loaded from the
 *  NetworkParameters table.
 */
export const DEFAULT_MIN_VALIDATOR_STAKE =
    "10000000000000000000000000"
