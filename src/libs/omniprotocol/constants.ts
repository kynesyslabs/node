/**
 * OmniProtocol Constants
 *
 * Centralized location for all hardcoded magic numbers and default values
 * used across the OmniProtocol module.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Server Defaults (OmniProtocolServer + startup)
// ─────────────────────────────────────────────────────────────────────────────

/** Default listen address for the OmniProtocol server */
export const DEFAULT_SERVER_HOST = "0.0.0.0"

/** Default maximum concurrent connections the server will accept */
export const DEFAULT_SERVER_MAX_CONNECTIONS = 1000

/** Default idle connection timeout in milliseconds (10 minutes) */
export const DEFAULT_SERVER_CONNECTION_TIMEOUT_MS = 10 * 60 * 1000 // 600_000

/** Default auth handshake timeout in milliseconds (5 seconds) */
export const DEFAULT_SERVER_AUTH_TIMEOUT_MS = 5_000

/** Default TCP backlog queue size */
export const DEFAULT_SERVER_BACKLOG = 511

/** Default TCP keepalive initial delay in milliseconds (60 seconds) */
export const DEFAULT_SERVER_KEEPALIVE_INITIAL_DELAY_MS = 60_000

/** Offset added to HTTP port to derive the default OmniProtocol port */
export const OMNI_PORT_OFFSET = 1

// ─────────────────────────────────────────────────────────────────────────────
// TLS Defaults (startup)
// ─────────────────────────────────────────────────────────────────────────────

/** Default TLS mode when no certificate paths are provided */
export const DEFAULT_TLS_MODE = "self-signed" as const

/** Default minimum TLS version */
export const DEFAULT_TLS_MIN_VERSION = "TLSv1.3" as const

// ─────────────────────────────────────────────────────────────────────────────
// Connection Pool Defaults (ConnectionPool)
// ─────────────────────────────────────────────────────────────────────────────

/** Default maximum total connections across all peers */
export const DEFAULT_POOL_MAX_TOTAL_CONNECTIONS = 100

/** Default maximum connections to a single peer */
export const DEFAULT_POOL_MAX_CONNECTIONS_PER_PEER = 1

/** Default idle timeout for pooled connections in milliseconds (10 minutes) */
export const DEFAULT_POOL_IDLE_TIMEOUT_MS = 10 * 60 * 1000 // 600_000

/** Default connection establishment timeout in milliseconds (5 seconds) */
export const DEFAULT_POOL_CONNECT_TIMEOUT_MS = 5_000

/** Default authentication timeout for pooled connections in milliseconds (5 seconds) */
export const DEFAULT_POOL_AUTH_TIMEOUT_MS = 5_000

/** Interval for periodic cleanup of idle/dead pooled connections in milliseconds (1 minute) */
export const POOL_CLEANUP_INTERVAL_MS = 60 * 1000 // 60_000

// ─────────────────────────────────────────────────────────────────────────────
// Rate Limiter Defaults (RateLimiter)
// ─────────────────────────────────────────────────────────────────────────────

/** Default maximum connections allowed per IP address */
export const DEFAULT_MAX_CONNECTIONS_PER_IP = 10

/** Default maximum requests per second per IP address */
export const DEFAULT_MAX_REQUESTS_PER_SECOND_PER_IP = 100

/** Default maximum requests per second per authenticated identity */
export const DEFAULT_MAX_REQUESTS_PER_SECOND_PER_IDENTITY = 200

/** Default sliding window duration in milliseconds (1 second) */
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 1_000

/** Default time-to-live for rate limit entries in milliseconds (1 minute) */
export const DEFAULT_RATE_LIMIT_ENTRY_TTL_MS = 60_000

/** Default interval for cleaning up expired rate limit entries in milliseconds (10 seconds) */
export const DEFAULT_RATE_LIMIT_CLEANUP_INTERVAL_MS = 10_000

/** Duration an IP/identity is blocked after exceeding rate limits in milliseconds (1 minute) */
export const RATE_LIMIT_BLOCK_DURATION_MS = 60_000

/** Default duration for manual blocks via blockKey() in milliseconds (1 hour) */
export const DEFAULT_MANUAL_BLOCK_DURATION_MS = 3_600_000

// ─────────────────────────────────────────────────────────────────────────────
// Server Connection Manager Defaults
// ─────────────────────────────────────────────────────────────────────────────

/** Interval for periodic cleanup of dead/idle server connections in milliseconds (1 minute) */
export const SERVER_CLEANUP_INTERVAL_MS = 60_000

// ─────────────────────────────────────────────────────────────────────────────
// Base Adapter Defaults
// ─────────────────────────────────────────────────────────────────────────────

/** Default HTTP port when none is specified in a URL */
export const DEFAULT_HTTP_PORT = 80

// ─────────────────────────────────────────────────────────────────────────────
// Protocol Config Defaults (types/config.ts - ConnectionPoolConfig extras)
// ─────────────────────────────────────────────────────────────────────────────

/** Default maximum concurrent requests per peer connection */
export const DEFAULT_MAX_CONCURRENT_REQUESTS = 100

/** Default maximum total concurrent requests across all connections */
export const DEFAULT_MAX_TOTAL_CONCURRENT_REQUESTS = 1_000

/** Default number of failures before circuit breaker trips */
export const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 5

/** Default circuit breaker cooldown timeout in milliseconds (30 seconds) */
export const DEFAULT_CIRCUIT_BREAKER_TIMEOUT_MS = 30_000

// ─────────────────────────────────────────────────────────────────────────────
// Protocol Config Defaults (types/config.ts - MigrationConfig)
// ─────────────────────────────────────────────────────────────────────────────

/** Default fallback timeout for migration mode in milliseconds (1 second) */
export const DEFAULT_MIGRATION_FALLBACK_TIMEOUT_MS = 1_000

// ─────────────────────────────────────────────────────────────────────────────
// Protocol Config Defaults (types/config.ts - ProtocolRuntimeConfig)
// ─────────────────────────────────────────────────────────────────────────────

/** OmniProtocol version number */
export const OMNI_PROTOCOL_VERSION = 0x01

/** Default timeout for standard protocol operations in milliseconds (3 seconds) */
export const DEFAULT_PROTOCOL_TIMEOUT_MS = 3_000

/** Default timeout for long-running protocol calls in milliseconds (10 seconds) */
export const DEFAULT_PROTOCOL_LONG_CALL_TIMEOUT_MS = 10_000

/** Default maximum payload size in bytes (10 MB) */
export const DEFAULT_MAX_PAYLOAD_SIZE = 10 * 1024 * 1024

// ─────────────────────────────────────────────────────────────────────────────
// Error Codes (types/errors.ts)
// ─────────────────────────────────────────────────────────────────────────────

/** Error code for unknown/unrecognized opcode */
export const ERROR_CODE_UNKNOWN_OPCODE = 0xf000

/** Error code for signing failures */
export const ERROR_CODE_SIGNING = 0xf001

/** Error code for connection errors */
export const ERROR_CODE_CONNECTION = 0xf002

/** Error code for connection timeout */
export const ERROR_CODE_CONNECTION_TIMEOUT = 0xf003

/** Error code for authentication failures */
export const ERROR_CODE_AUTHENTICATION = 0xf004

/** Error code for pool capacity exceeded */
export const ERROR_CODE_POOL_CAPACITY = 0xf005

/** Error code for invalid auth block format */
export const ERROR_CODE_INVALID_AUTH_BLOCK_FORMAT = 0xf006

/** Error code for unauthorized requests (missing or invalid authentication) */
export const ERROR_CODE_UNAUTHORIZED = 0xf401
