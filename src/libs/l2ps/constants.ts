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
// Hash Service – OmniProtocol connection pool defaults
// ---------------------------------------------------------------------------






