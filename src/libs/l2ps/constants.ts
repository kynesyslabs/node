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

/** Maximum total TCP connections the hash-relay pool may hold open */
export const HASH_RELAY_MAX_TOTAL_CONNECTIONS = 50

/** Maximum TCP connections to a single peer for hash relay */
export const HASH_RELAY_MAX_CONNECTIONS_PER_PEER = 3

/** Idle timeout for hash-relay TCP connections (ms) – 5 minutes */
export const HASH_RELAY_IDLE_TIMEOUT_MS = 5 * 60 * 1000

/** TCP connect timeout for hash-relay connections (ms) */
export const HASH_RELAY_CONNECT_TIMEOUT_MS = 5_000

/** Authentication handshake timeout for hash-relay connections (ms) */
export const HASH_RELAY_AUTH_TIMEOUT_MS = 5_000

/** Timeout when sending a hash update via OmniProtocol (ms) */
export const HASH_RELAY_OMNI_REQUEST_TIMEOUT_MS = 10_000
