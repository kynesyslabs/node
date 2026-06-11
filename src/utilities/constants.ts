/**
 * Application-wide constants.
 *
 * Values that never change at runtime and are not configurable via env vars.
 * For env-based configuration, see src/config/.
 */

// --- Application metadata ---
export const APP_VERSION = "0.9.8"
export const APP_VERSION_NAME = "Oxlong Michael"
export const DEFAULT_SIGNING_ALGORITHM = "ed25519" as const

// --- Consensus / Block timing ---
/** Default block time in seconds (should come from genesis in the future) */
export const DEFAULT_BLOCK_TIME = 10

// --- Peer management ---
/** How often to recheck peers (ms) */
export const PEER_RECHECK_INTERVAL_MS = 10_000

/**
 * Max transactions accepted from a single peer in one mergeMempools round.
 * Bounds the work a peer can push onto the consensus-critical tick — without
 * a cap one peer can return an unbounded tx list, forcing unbounded
 * validation+insert synchronously inside block production (audit H4).
 * Generous (a healthy mempool is far smaller) but finite.
 */
export const MERGE_MEMPOOL_MAX_TXS_PER_PEER = 5_000

// --- Batch sync ---
export const BATCH_SYNC_BLOCK_SIZE = 100
export const BATCH_SYNC_TX_SIZE = 100
export const BATCH_SYNC_TX_LIMIT = 100
export const BATCH_SYNC_BLOCK_LIMIT = 100

// --- Rate limiting defaults ---
export const RATE_LIMIT_DEFAULT_MAX_REQUESTS = 2000
export const RATE_LIMIT_DEFAULT_WINDOW_MS = 60_000
export const RATE_LIMIT_POST_MAX_REQUESTS = 200_000
export const RATE_LIMIT_POST_WINDOW_MS = 86_400_000
export const RATE_LIMIT_TX_PER_BLOCK = 4

// /identities is an expensive full-table read; throttle it far below the
// default GET allowance (per-IP) and cap how many can run at once (global).
export const RATE_LIMIT_IDENTITIES_MAX_REQUESTS = 30
export const RATE_LIMIT_IDENTITIES_WINDOW_MS = 60_000
/** Max concurrent /identities executions across ALL callers. */
export const IDENTITIES_MAX_CONCURRENT = 3
/** Max callers allowed to wait for a free /identities slot before a fast 503. */
export const IDENTITIES_MAX_QUEUE = 12
/** How long a queued /identities caller waits for a slot before a 503. */
export const IDENTITIES_ACQUIRE_TIMEOUT_MS = 2_000
/** Default page size when /identities is called without a valid ?limit. */
export const IDENTITIES_DEFAULT_LIMIT = 100
/** Hard cap on the /identities page size so one request can't dump the table. */
export const IDENTITIES_MAX_LIMIT = 1000

/** Localhost IPs that always bypass rate limiting */
export const LOCALHOST_IPS = [
    "127.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
] as const

// --- File defaults ---
export const TWITTER_COOKIE_FILE = "twitter_cookies.json"
