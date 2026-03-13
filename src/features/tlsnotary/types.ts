/**
 * TLSNotary Types and Interfaces
 *
 * Centralized type definitions for the TLSNotary feature module.
 * All interfaces, types, and enums used across TLSNotary files are defined here.
 *
 * @module features/tlsnotary/types
 */

import type { ChildProcess } from "child_process"

// ============================================================================
// FFI Types (from ffi.ts)
// ============================================================================

/**
 * Configuration for the TLSNotary instance
 */
export interface NotaryConfig {
  /** 32-byte secp256k1 private key for signing attestations */
  signingKey: Uint8Array;
  /** Maximum bytes the prover can send (default: 16KB) */
  maxSentData?: number;
  /** Maximum bytes the prover can receive (default: 64KB) */
  maxRecvData?: number;
}

/**
 * Result of attestation verification
 */
export interface VerificationResult {
  /** Whether verification succeeded */
  success: boolean;
  /** Server name from the TLS session */
  serverName?: string;
  /** Unix timestamp of the connection */
  connectionTime?: number;
  /** Bytes sent by the prover */
  sentLength?: number;
  /** Bytes received by the prover */
  recvLength?: number;
  /** Error message if verification failed */
  error?: string;
}

/**
 * Health check status for the notary service
 */
export interface NotaryHealthStatus {
  /** Whether the notary is operational */
  healthy: boolean;
  /** Whether the library is initialized */
  initialized: boolean;
  /** Whether the server is running */
  serverRunning: boolean;
  /** Compressed public key (33 bytes, hex encoded) */
  publicKey?: string;
  /** Error message if unhealthy */
  error?: string;
}

// ============================================================================
// Service Types (from TLSNotaryService.ts)
// ============================================================================

/**
 * TLSNotary operational mode
 */
export type TLSNotaryMode = "ffi" | "docker";

/**
 * Service configuration options
 */
export interface TLSNotaryServiceConfig {
  /** Port to run the notary WebSocket server on */
  port: number;
  /** 32-byte secp256k1 private key (hex string or Uint8Array) - only used in FFI mode */
  signingKey?: string | Uint8Array;
  /** Maximum bytes the prover can send (default: 16KB) */
  maxSentData?: number;
  /** Maximum bytes the prover can receive (default: 64KB) */
  maxRecvData?: number;
  /** Whether to auto-start the server on initialization */
  autoStart?: boolean;
  /** Operational mode: 'ffi' (Rust FFI) or 'docker' (Docker container) */
  mode?: TLSNotaryMode;
}

/**
 * Service status information
 */
export interface TLSNotaryServiceStatus {
  /** Whether the service is enabled */
  enabled: boolean;
  /** Whether the service is running */
  running: boolean;
  /** Port the service is listening on */
  port: number;
  /** Health status from the underlying notary */
  health: NotaryHealthStatus;
  /** Operating mode: docker or ffi */
  mode?: TLSNotaryMode;
}

// ============================================================================
// Proxy Manager Types (from proxyManager.ts)
// ============================================================================

/**
 * Error codes for proxy operations
 */
export enum ProxyError {
  PROXY_SPAWN_FAILED = "PROXY_SPAWN_FAILED",
  PORT_EXHAUSTED = "PORT_EXHAUSTED",
  INVALID_URL = "INVALID_URL",
  WSTCP_NOT_AVAILABLE = "WSTCP_NOT_AVAILABLE",
}

/**
 * Information about a running proxy
 */
export interface ProxyInfo {
  proxyId: string // uuid
  domain: string // "api.example.com"
  targetPort: number // 443
  port: number // allocated local port (55123)
  process: ChildProcess // wstcp process handle
  lastActivity: number // Date.now() timestamp
  spawnedAt: number // Date.now() timestamp
  websocketProxyUrl: string // "ws://node.demos.sh:55123"
}

/**
 * TLSNotary state stored in sharedState
 */
export interface TLSNotaryState {
  proxies: Map<string, ProxyInfo> // keyed by "domain:port"
  portPool: PortPoolState
}

/**
 * Success response for proxy request
 */
export interface ProxyRequestSuccess {
  websocketProxyUrl: string
  targetDomain: string
  expiresIn: number
  proxyId: string
}

/**
 * Error response for proxy request
 */
export interface ProxyRequestError {
  error: ProxyError
  message: string
  targetDomain?: string
  lastError?: string
}

// ============================================================================
// Port Allocator Types (from portAllocator.ts)
// ============================================================================

/**
 * Port pool state interface
 */
export interface PortPoolState {
  next: number // next port to try (55000-57000)
  max: number // 57000
  recycled: number[] // freed ports available for reuse
}

// ============================================================================
// Token Manager Types (from tokenManager.ts)
// ============================================================================

/**
 * Token status enum
 */
export enum TokenStatus {
  PENDING = "pending", // Created, not yet used
  ACTIVE = "active", // Proxy spawned, attestation in progress
  COMPLETED = "completed", // Attestation successful
  STORED = "stored", // Proof stored on-chain/IPFS
  EXHAUSTED = "exhausted", // Max retries reached
  EXPIRED = "expired", // Time limit exceeded
}

/**
 * Attestation token structure
 */
export interface AttestationToken {
  id: string
  owner: string // pubkey of the payer
  domain: string // locked domain (e.g., "api.example.com")
  status: TokenStatus
  createdAt: number // timestamp
  expiresAt: number // timestamp
  retriesLeft: number
  txHash: string // original payment tx hash
  proxyId?: string // linked proxy ID once spawned
}

/**
 * Token store state (stored in sharedState)
 */
export interface TokenStoreState {
  tokens: Map<string, AttestationToken>
  cleanupTimer?: ReturnType<typeof setInterval>
}

/**
 * Validation result for token checks
 */
export interface TokenValidationResult {
  valid: boolean
  error?: string
  token?: AttestationToken
}

// ============================================================================
// Route Types (from routes.ts)
// ============================================================================

/**
 * Verify attestation request body
 */
export interface VerifyRequestBody {
  /** Base64-encoded attestation bytes */
  attestation: string;
}

/**
 * Health response
 */
export interface HealthResponse {
  status: "healthy" | "unhealthy" | "disabled";
  service: string;
  initialized?: boolean;
  serverRunning?: boolean;
  error?: string;
}

/**
 * Info response
 */
export interface InfoResponse {
  enabled: boolean;
  port: number;
  publicKey?: string;
  running?: boolean;
}

/**
 * Verify response
 */
export interface VerifyResponse {
  success: boolean;
  serverName?: string;
  connectionTime?: number;
  sentLength?: number;
  recvLength?: number;
  error?: string;
}
