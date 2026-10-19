/**
 * L2PS Constants
 *
 * Centralised magic numbers and hardcoded values used across the L2PS subsystem.
 */

// ---------------------------------------------------------------------------
// Batch Aggregator
// ---------------------------------------------------------------------------

/** Maximum transactions a ZK circuit can handle in a single batch */
export const ZK_CIRCUIT_MAX_BATCH_SIZE = 10

/** Domain separator for batch transaction signatures (prevents cross-protocol reuse) */
export const BATCH_SIGNATURE_DOMAIN = "L2PS_BATCH_TX_V1"

// ---------------------------------------------------------------------------
// History retention
// ---------------------------------------------------------------------------

/**
 * Minimum gap between history retention sweeps (ms) – 1 hour.
 * Retention is measured in days, so sweeping on every aggregation cycle only
 * repeats the same delete scan.
 */
export const HISTORY_RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000
