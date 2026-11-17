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
   * Minimum/maximum port for proxy session allocation. Overridable via env so
   * the published host range (docker-compose `ports:`) can be narrowed to a
   * window the reverse proxy can actually reach — the proxies bind dynamic
   * ports in this range and nginx forwards `/tlsn/<port>/` to them, so the
   * range MUST be host-reachable or every verification 502s. Defaults keep
   * the historical 55000-57000 behaviour.
   */
  PORT_MIN: Number(process.env.TLSNOTARY_PROXY_PORT_MIN) || 55000,
  PORT_MAX: Number(process.env.TLSNOTARY_PROXY_PORT_MAX) || 57000,
  /** Maximum number of listen attempts on fresh ports per proxy request */
  MAX_SPAWN_RETRIES: 3,
  /** Timeout for probing whether a port is free (5 seconds) */
  SPAWN_TIMEOUT_MS: 5000,
}

// ============================================================================
// Proxy session limits (proxyRelay.ts, proxyAccess.ts)
// ============================================================================

/**
 * Bounds on what one paid tlsn_request can make this node relay. The relay is
 * a raw TCP tunnel from the node's address, so every session ends on its own
 * whatever the client does.
 */
export const PROXY_LIMITS = {
  /**
   * Hard end of a session after it is granted. The prover runs the notary
   * setup before it opens the proxy websocket, which takes tens of seconds in
   * a browser and longer on a phone.
   */
  SESSION_MAX_LIFETIME_MS: 5 * 60 * 1000,
  /** End of a connected session that relays nothing in either direction. */
  SESSION_IDLE_MS: 60 * 1000,
  /** How long a client may take to read what the target sent before it closed. */
  CLOSE_DRAIN_MS: 10 * 1000,
  /**
   * Room over the notary's plaintext limits for the TLS handshake (the
   * server's certificate chain dominates), record framing and alerts.
   */
  SENT_MARGIN_BYTES: 16 * 1024,
  RECV_MARGIN_BYTES: 32 * 1024,
  /** Sessions one token can open on this node, one live at a time. */
  MAX_SESSIONS_PER_TOKEN: 3,
  MAX_LIVE_SESSIONS_PER_OWNER: 2,
  MAX_LIVE_SESSIONS_PER_IP: 4,
  /** requestTLSNproxy calls per window, counted before any chain read. */
  REQUESTS_PER_WINDOW_PER_IP: 20,
  REQUESTS_PER_WINDOW_PER_OWNER: 6,
  RATE_WINDOW_MS: 60 * 1000,
}

/**
 * Byte caps per direction for one session: twice the notary's plaintext limit
 * plus the margin, so an attestation the notary accepts is never cut while a
 * session cannot become a general-purpose tunnel.
 */
export function proxyByteCaps(maxSentData: number, maxRecvData: number): {
  maxSentBytes: number
  maxRecvBytes: number
} {
  return {
    maxSentBytes: 2 * maxSentData + PROXY_LIMITS.SENT_MARGIN_BYTES,
    maxRecvBytes: 2 * maxRecvData + PROXY_LIMITS.RECV_MARGIN_BYTES,
  }
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
