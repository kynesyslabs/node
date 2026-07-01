/**
 * TLSNotary Constants
 *
 * Centralized constants for the TLSNotary feature module.
 * All magic numbers, hardcoded strings, and configuration defaults are defined here.
 *
 * @module features/tlsnotary/constants
 */

// ============================================================================
// Service Constants (from TLSNotaryService.ts)
// ============================================================================

/** File name for persistent storage of auto-generated signing keys */
export const SIGNING_KEY_FILE = ".tlsnotary-key"

/** Expected length of a hex-encoded 32-byte signing key */
export const SIGNING_KEY_HEX_LENGTH = 64

/** Signing key size in bytes (secp256k1 private key) */
export const SIGNING_KEY_BYTES = 32

/** Compressed secp256k1 public key size in bytes */
export const PUBLIC_KEY_BYTES = 33

/** Default WebSocket server port for TLSNotary */
export const DEFAULT_NOTARY_PORT = 7047

/** Default maximum bytes the prover can send (16KB) */
export const DEFAULT_MAX_SENT_DATA = 16384

/** Default maximum bytes the prover can receive (64KB) */
export const DEFAULT_MAX_RECV_DATA = 65536

/** Timeout in ms for Docker container health check */
export const DOCKER_HEALTH_TIMEOUT_MS = 5000

/** Size of the FFI NotaryConfigFFI struct in bytes */
export const FFI_CONFIG_BUFFER_SIZE = 40

/** File permissions for auto-generated signing key (owner read/write only) */
export const SIGNING_KEY_FILE_MODE = 0o600

// ============================================================================
// Port Allocator Constants (from portAllocator.ts)
// ============================================================================

/**
 * Configuration constants for port allocation and proxy lifecycle
 */
export const PORT_CONFIG = {
  /**
   * Minimum/maximum port for wstcp proxy allocation. Overridable via env so
   * the published host range (docker-compose `ports:`) can be narrowed to a
   * window the reverse proxy can actually reach — the proxies bind dynamic
   * ports in this range and nginx forwards `/tlsn/<port>/` to them, so the
   * range MUST be host-reachable or every verification 502s. Defaults keep
   * the historical 55000-57000 behaviour.
   */
  PORT_MIN: Number(process.env.TLSNOTARY_PROXY_PORT_MIN) || 55000,
  PORT_MAX: Number(process.env.TLSNOTARY_PROXY_PORT_MAX) || 57000,
  /** Idle timeout before a proxy is considered stale (30 seconds) */
  IDLE_TIMEOUT_MS: 30000,
  /** Maximum number of spawn retry attempts */
  MAX_SPAWN_RETRIES: 3,
  /** Timeout for wstcp process to start (5 seconds) */
  SPAWN_TIMEOUT_MS: 5000,
}

// ============================================================================
// Token Manager Constants (from tokenManager.ts)
// ============================================================================

/**
 * Token configuration constants
 */
export const TOKEN_CONFIG = {
  /** Token expiry time (30 minutes) */
  EXPIRY_MS: 30 * 60 * 1000,
  /** Maximum retry attempts per token */
  MAX_RETRIES: 3,
  /** Interval for cleaning up expired tokens (1 minute) */
  CLEANUP_INTERVAL_MS: 60 * 1000,
}
