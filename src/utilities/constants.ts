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
export const DEFAULT_BLOCK_TIME = 20

// --- Peer management ---
/** How often to recheck peers (ms) */
export const PEER_RECHECK_INTERVAL_MS = 10_000

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

/** Localhost IPs that always bypass rate limiting */
export const LOCALHOST_IPS = [
    "127.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
] as const

// --- File defaults ---
export const TWITTER_COOKIE_FILE = "twitter_cookies.json"
