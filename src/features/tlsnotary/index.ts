/**
 * TLSNotary Feature Module
 *
 * Provides HTTPS attestation capabilities using TLSNotary (MPC-TLS).
 * Enables verifiable proofs of web content without compromising user privacy.
 *
 * ## Architecture
 *
 * ```
 * Browser (tlsn-js WASM) <--WebSocket--> Notary Server (Rust FFI)
 *         │                                      │
 *         │ attest()                             │ participates in MPC-TLS
 *         ▼                                      ▼
 *   Generates Attestation            Signs attestation with secp256k1
 *         │
 *         ▼
 *  SDK (demosdk/tlsnotary) <--HTTP--> Node (/tlsnotary/verify)
 *                                           │
 *                                           ▼
 *                                    Verifies signature & data
 * ```
 *
 * ## Environment Variables
 *
 * - TLSNOTARY_DISABLED: Disable the feature (default: false, i.e. enabled by default)
 * - TLSNOTARY_PORT: WebSocket port (default: 7047)
 * - TLSNOTARY_SIGNING_KEY: 32-byte hex secp256k1 key (required if enabled)
 * - TLSNOTARY_MAX_SENT_DATA: Max sent bytes (default: 16384)
 * - TLSNOTARY_MAX_RECV_DATA: Max recv bytes (default: 65536)
 * - TLSNOTARY_AUTO_START: Auto-start on init (default: true)
 * - TLSNOTARY_FATAL: Make errors fatal for debugging (default: false)
 * - TLSNOTARY_DEBUG: Enable verbose debug logging (default: false)
 * - TLSNOTARY_PROXY: Enable TCP proxy to log incoming data (default: false)
 *
 * ## Usage
 *
 * ```typescript
 * import { initializeTLSNotary, shutdownTLSNotary } from '@/features/tlsnotary';
 *
 * // Initialize (reads from environment, optionally pass BunServer for routes)
 * await initializeTLSNotary(bunServer);
 *
 * // On shutdown
 * await shutdownTLSNotary();
 * ```
 *
 * @module features/tlsnotary
 */

// REVIEW: TLSNotary feature module - entry point for HTTPS attestation feature
import type { BunServer } from "@/libs/network/bunServer"
import {
  TLSNotaryService,
  getTLSNotaryService,
  initializeTLSNotaryService,
  shutdownTLSNotaryService,
  getConfigFromEnv,
} from "./TLSNotaryService"
import { registerTLSNotaryRoutes } from "./routes"
import log from "@/utilities/logger"

// Re-export types and classes
export { TLSNotaryService, getTLSNotaryService, getConfigFromEnv, isTLSNotaryFatal, isTLSNotaryDebug, isTLSNotaryProxy } from "./TLSNotaryService"
export { TLSNotaryFFI } from "./ffi"
export type { NotaryConfig, VerificationResult, NotaryHealthStatus } from "./ffi"
export type { TLSNotaryServiceConfig, TLSNotaryServiceStatus } from "./TLSNotaryService"

/**
 * Initialize TLSNotary feature
 *
 * Reads configuration from environment, initializes the service if enabled,
 * and optionally registers HTTP routes with BunServer.
 *
 * @param server - Optional BunServer instance for route registration
 * @returns True if enabled and initialized successfully
 */
export async function initializeTLSNotary(server?: BunServer): Promise<boolean> {
  const config = getConfigFromEnv()

  if (!config) {
    log.info("[TLSNotary] Feature disabled (TLSNOTARY_DISABLED=true)")
    return false
  }

  try {
    // Initialize the service
    const service = await initializeTLSNotaryService()

    if (!service) {
      log.warning("[TLSNotary] Failed to create service instance")
      return false
    }

    // Register HTTP routes if server is provided
    if (server) {
      registerTLSNotaryRoutes(server)
    }

    const publicKeyHex = service.getPublicKeyHex()
    log.info("[TLSNotary] Feature initialized successfully")
    log.info(`[TLSNotary] WebSocket server on port: ${service.getPort()}`)
    log.info(`[TLSNotary] Public key: ${publicKeyHex}`)

    return true
  } catch (error) {
    log.error("[TLSNotary] Failed to initialize:", error)
    return false
  }
}

/**
 * Shutdown TLSNotary feature
 *
 * Stops the WebSocket server and releases all resources.
 */
export async function shutdownTLSNotary(): Promise<void> {
  try {
    await shutdownTLSNotaryService()
    log.info("[TLSNotary] Feature shutdown complete")
  } catch (error) {
    log.error("[TLSNotary] Error during shutdown:", error)
  }
}

/**
 * Check if TLSNotary is enabled
 * @returns True if enabled in environment
 */
export function isTLSNotaryEnabled(): boolean {
  return getConfigFromEnv() !== null
}

/**
 * Get TLSNotary service status
 * @returns Service status or null if not enabled
 */
export function getTLSNotaryStatus() {
  const service = getTLSNotaryService()
  if (!service) {
    return null
  }
  return service.getStatus()
}

export default {
  initialize: initializeTLSNotary,
  shutdown: shutdownTLSNotary,
  isEnabled: isTLSNotaryEnabled,
  getStatus: getTLSNotaryStatus,
  getService: getTLSNotaryService,
}
