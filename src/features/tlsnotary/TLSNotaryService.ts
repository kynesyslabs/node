/**
 * TLSNotary Service for Demos Node
 *
 * High-level service class that wraps TLSNotary functionality with lifecycle management,
 * configuration from environment, and integration with the Demos node ecosystem.
 *
 * Supports two modes:
 * - FFI Mode: Uses Rust FFI bindings (requires libtlsn_notary.so) - DEPRECATED
 * - Docker Mode: Uses official Docker notary-server image (recommended)
 *
 * @module features/tlsnotary/TLSNotaryService
 */

// REVIEW: TLSNotaryService - updated to support Docker mode alongside FFI
import { TLSNotaryFFI, type NotaryConfig, type VerificationResult, type NotaryHealthStatus } from "./ffi"
import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { randomBytes } from "crypto"
import log from "@/utilities/logger"

// ============================================================================
// Types
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
// Environment Configuration
// ============================================================================

// REVIEW: Key file path for persistent storage of auto-generated keys
const SIGNING_KEY_FILE = ".tlsnotary-key"

/**
 * Resolve the TLSNotary signing key with priority: ENV > file > auto-generate
 *
 * Priority order:
 * 1. TLSNOTARY_SIGNING_KEY environment variable (highest priority)
 * 2. .tlsnotary-key file in project root
 * 3. Auto-generate and save to .tlsnotary-key file
 *
 * @returns 64-character hex string (32-byte key) or null on error
 */
function resolveSigningKey(): string | null {
  // Priority 1: Environment variable
  const envKey = process.env.TLSNOTARY_SIGNING_KEY
  if (envKey && envKey.length === 64) {
    log.info("[TLSNotary] Using signing key from environment variable")
    return envKey
  } else if (envKey && envKey.length !== 64) {
    log.warning("[TLSNotary] TLSNOTARY_SIGNING_KEY must be 64 hex characters (32 bytes)")
    return null
  }

  // Priority 2: Key file
  const keyFilePath = join(process.cwd(), SIGNING_KEY_FILE)
  if (existsSync(keyFilePath)) {
    try {
      const fileKey = readFileSync(keyFilePath, "utf-8").trim()
      if (fileKey.length === 64) {
        log.info(`[TLSNotary] Using signing key from ${SIGNING_KEY_FILE}`)
        return fileKey
      } else {
        log.warning(`[TLSNotary] Invalid key in ${SIGNING_KEY_FILE} (must be 64 hex characters)`)
        return null
      }
    } catch (error) {
      log.warning(`[TLSNotary] Failed to read ${SIGNING_KEY_FILE}: ${error}`)
      return null
    }
  }

  // Priority 3: Auto-generate and save
  try {
    const generatedKey = randomBytes(32).toString("hex")
    writeFileSync(keyFilePath, generatedKey, { mode: 0o600 }) // Restrictive permissions
    log.info(`[TLSNotary] Auto-generated signing key saved to ${SIGNING_KEY_FILE}`)
    return generatedKey
  } catch (error) {
    log.error(`[TLSNotary] Failed to auto-generate signing key: ${error}`)
    return null
  }
}

/**
 * Check if TLSNotary errors should be fatal (for debugging)
 * When TLSNOTARY_FATAL=true, errors will cause process exit
 */
export function isTLSNotaryFatal(): boolean {
  return process.env.TLSNOTARY_FATAL?.toLowerCase() === "true"
}

/**
 * Check if TLSNotary debug mode is enabled
 * When TLSNOTARY_DEBUG=true, additional logging is enabled
 */
export function isTLSNotaryDebug(): boolean {
  return process.env.TLSNOTARY_DEBUG?.toLowerCase() === "true"
}

/**
 * Check if TLSNotary proxy mode is enabled
 * When TLSNOTARY_PROXY=true, a TCP proxy intercepts and logs all incoming data
 * before forwarding to the Rust server. Useful for debugging what data is arriving.
 */
export function isTLSNotaryProxy(): boolean {
  return process.env.TLSNOTARY_PROXY?.toLowerCase() === "true"
}

/**
 * Get TLSNotary configuration from environment variables
 *
 * Environment variables:
 * - TLSNOTARY_DISABLED: Disable the service (default: false, i.e. enabled by default)
 * - TLSNOTARY_MODE: Operational mode - 'docker' (default) or 'ffi'
 * - TLSNOTARY_PORT: Port for the notary server (default: 7047)
 * - TLSNOTARY_SIGNING_KEY: 32-byte hex-encoded secp256k1 private key (only for FFI mode)
 * - TLSNOTARY_MAX_SENT_DATA: Maximum sent data bytes (default: 16384)
 * - TLSNOTARY_MAX_RECV_DATA: Maximum received data bytes (default: 65536)
 * - TLSNOTARY_AUTO_START: Auto-start on initialization (default: true)
 * - TLSNOTARY_FATAL: Make TLSNotary errors fatal for debugging (default: false)
 * - TLSNOTARY_DEBUG: Enable verbose debug logging (default: false)
 * - TLSNOTARY_PROXY: Enable TCP proxy to log incoming data before forwarding (default: false)
 *
 * Signing Key Resolution Priority (FFI mode only):
 * 1. TLSNOTARY_SIGNING_KEY environment variable
 * 2. .tlsnotary-key file in project root
 * 3. Auto-generate and save to .tlsnotary-key
 *
 * @returns Configuration object or null if service is disabled
 */
export function getConfigFromEnv(): TLSNotaryServiceConfig | null {
  const disabled = process.env.TLSNOTARY_DISABLED?.toLowerCase() === "true"

  if (disabled) {
    return null
  }

  // Determine mode: default to 'docker' as it's more compatible with tlsn-js
  const mode = (process.env.TLSNOTARY_MODE?.toLowerCase() === "ffi" ? "ffi" : "docker") as TLSNotaryMode

  // Only require signing key for FFI mode
  let signingKey: string | undefined
  if (mode === "ffi") {
    signingKey = resolveSigningKey() ?? undefined
    if (!signingKey) {
      log.warning("[TLSNotary] Failed to resolve signing key for FFI mode")
      return null
    }
  }

  return {
    port: Number.parseInt(process.env.TLSNOTARY_PORT ?? "7047", 10),
    signingKey,
    maxSentData: Number.parseInt(process.env.TLSNOTARY_MAX_SENT_DATA ?? "16384", 10),
    maxRecvData: Number.parseInt(process.env.TLSNOTARY_MAX_RECV_DATA ?? "65536", 10),
    autoStart: process.env.TLSNOTARY_AUTO_START?.toLowerCase() !== "false",
    mode,
  }
}

// ============================================================================
// TLSNotaryService Class
// ============================================================================

/**
 * TLSNotary Service
 *
 * Manages the TLSNotary instance lifecycle, provides health checks,
 * and exposes verification functionality.
 *
 * @example
 * ```typescript
 * import { TLSNotaryService } from '@/features/tlsnotary/TLSNotaryService';
 *
 * // Initialize from environment
 * const service = TLSNotaryService.fromEnvironment();
 * if (service) {
 *   await service.start();
 *   console.log('TLSNotary running on port', service.getPort());
 *   console.log('Public key:', service.getPublicKeyHex());
 * }
 *
 * // Or with explicit config
 * const service = new TLSNotaryService({
 *   port: 7047,
 *   signingKey: '0x...',  // 64 hex chars
 * });
 * await service.start();
 * ```
 */
export class TLSNotaryService {
  private ffi: TLSNotaryFFI | null = null
  private readonly config: TLSNotaryServiceConfig
  private running = false
  private dockerPublicKey: string | null = null  // Cached public key from Docker notary
  private proxyServer: import("net").Server | null = null

  /**
   * Create a new TLSNotaryService instance
   * @param config - Service configuration
   */
  constructor(config: TLSNotaryServiceConfig) {
    this.config = {
      ...config,
      mode: config.mode ?? "docker",  // Default to docker mode
    }
  }

  /**
   * Get the operational mode
   */
  getMode(): TLSNotaryMode {
    return this.config.mode ?? "docker"
  }

  /**
   * Create a TLSNotaryService from environment variables
   * @returns Service instance or null if not enabled/configured
   */
  static fromEnvironment(): TLSNotaryService | null {
    const config = getConfigFromEnv()
    if (!config) {
      return null
    }
    return new TLSNotaryService(config)
  }

  /**
   * Initialize and optionally start the notary service
   * @throws Error if initialization fails
   */
  async initialize(): Promise<void> {
    const debug = isTLSNotaryDebug()
    const fatal = isTLSNotaryFatal()
    const mode = this.getMode()

    if (debug) {
      log.info("[TLSNotary] Debug mode enabled - verbose logging active")
    }
    if (fatal) {
      log.warning("[TLSNotary] Fatal mode enabled - errors will cause process exit")
    }

    log.info(`[TLSNotary] Initializing in ${mode.toUpperCase()} mode`)

    if (mode === "docker") {
      // Docker mode: just verify the container is accessible
      await this.initializeDockerMode()
    } else {
      // FFI mode: initialize Rust FFI
      await this.initializeFFIMode()
    }

    // Auto-start if configured
    if (this.config.autoStart) {
      await this.start()
    }
  }

  /**
   * Initialize Docker mode - verify container is running
   * @private
   */
  private async initializeDockerMode(): Promise<void> {
    const debug = isTLSNotaryDebug()

    if (debug) {
      log.info(`[TLSNotary] Docker mode: expecting container on port ${this.config.port}`)
    }

    // In Docker mode, we don't start the container here - that's handled by the run script
    // We just mark as initialized and will check connectivity in start()
    log.info("[TLSNotary] Docker mode initialized (container managed externally)")

    if (debug) {
      log.info(`[TLSNotary] Config: port=${this.config.port}`)
      log.info("[TLSNotary] Container should be started via: cd tlsnotary && docker compose up -d")
    }
  }

  /**
   * Initialize FFI mode - load Rust library
   * @private
   */
  private async initializeFFIMode(): Promise<void> {
    if (this.ffi) {
      log.warning("[TLSNotary] FFI already initialized")
      return
    }

    const debug = isTLSNotaryDebug()
    const fatal = isTLSNotaryFatal()

    // Convert signing key to Uint8Array if it's a hex string
    let signingKeyBytes: Uint8Array
    if (typeof this.config.signingKey === "string") {
      signingKeyBytes = Buffer.from(this.config.signingKey, "hex")
    } else if (this.config.signingKey) {
      signingKeyBytes = this.config.signingKey
    } else {
      const error = new Error("Signing key required for FFI mode")
      if (fatal) {
        log.error("[TLSNotary] FATAL: " + error.message)
        process.exit(1)
      }
      throw error
    }

    if (signingKeyBytes.length !== 32) {
      const error = new Error("Signing key must be exactly 32 bytes")
      if (fatal) {
        log.error("[TLSNotary] FATAL: " + error.message)
        process.exit(1)
      }
      throw error
    }

    const ffiConfig: NotaryConfig = {
      signingKey: signingKeyBytes,
      maxSentData: this.config.maxSentData,
      maxRecvData: this.config.maxRecvData,
    }

    try {
      this.ffi = new TLSNotaryFFI(ffiConfig)
      log.info("[TLSNotary] FFI service initialized")

      if (debug) {
        log.info(`[TLSNotary] Config: port=${this.config.port}, maxSentData=${this.config.maxSentData}, maxRecvData=${this.config.maxRecvData}`)
      }
    } catch (error) {
      log.error("[TLSNotary] Failed to initialize FFI: " + error)
      if (fatal) {
        log.error("[TLSNotary] FATAL: Exiting due to initialization failure")
        process.exit(1)
      }
      throw error
    }
  }

  /**
   * Start the notary WebSocket server
   * @throws Error if not initialized or server fails to start
   */
  async start(): Promise<void> {
    const mode = this.getMode()

    if (this.running) {
      log.warning("[TLSNotary] Server already running")
      return
    }

    if (mode === "docker") {
      await this.startDockerMode()
    } else {
      await this.startFFIMode()
    }
  }

  /**
   * Start in Docker mode - verify container is running and accessible
   * @private
   */
  private async startDockerMode(): Promise<void> {
    const debug = isTLSNotaryDebug()
    const fatal = isTLSNotaryFatal()

    log.info(`[TLSNotary] Docker mode: checking container on port ${this.config.port}...`)

    try {
      // Try to fetch /info endpoint to verify container is running
      const infoUrl = `http://localhost:${this.config.port}/info`
      const response = await fetch(infoUrl, { signal: AbortSignal.timeout(5000) })

      if (!response.ok) {
        throw new Error(`Notary server returned ${response.status}`)
      }

      const info = await response.json() as { publicKey?: string; version?: string }
      this.dockerPublicKey = info.publicKey ?? null

      this.running = true
      log.info("[TLSNotary] Docker container is running and accessible")

      if (debug) {
        log.info(`[TLSNotary] Notary info: ${JSON.stringify(info)}`)
      }

      if (this.dockerPublicKey) {
        log.info(`[TLSNotary] Notary public key: ${this.dockerPublicKey}`)
      }

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error(`[TLSNotary] Failed to connect to Docker notary on port ${this.config.port}: ${message}`)
      log.error("[TLSNotary] Make sure the Docker container is running:")
      log.error("[TLSNotary]   cd tlsnotary && TLSNOTARY_PORT=${TLSNOTARY_PORT} docker compose up -d")

      if (fatal) {
        log.error("[TLSNotary] FATAL: Exiting due to Docker container not available")
        process.exit(1)
      }
      throw new Error(`Docker notary container not accessible: ${message}`)
    }
  }

  /**
   * Start in FFI mode - start the Rust WebSocket server
   * @private
   */
  private async startFFIMode(): Promise<void> {
    const debug = isTLSNotaryDebug()
    const fatal = isTLSNotaryFatal()
    const proxyEnabled = isTLSNotaryProxy()

    if (!this.ffi) {
      const error = new Error("FFI not initialized. Call initialize() first.")
      if (fatal) {
        log.error("[TLSNotary] FATAL: " + error.message)
        process.exit(1)
      }
      throw error
    }

    try {
      if (debug) {
        log.info(`[TLSNotary] Starting WebSocket server on port ${this.config.port}...`)
        log.info("[TLSNotary] NOTE: TLSNotary only accepts WebSocket connections via HTTP GET")
        log.info("[TLSNotary] Non-GET requests (POST, PUT, etc.) will fail with WebSocket upgrade error")
      }

      // REVIEW: Debug proxy mode - intercepts and logs all incoming data before forwarding
      if (proxyEnabled) {
        await this.startWithProxy()
      } else {
        await this.ffi.startServer(this.config.port)
      }

      this.running = true
      log.info(`[TLSNotary] FFI server started on port ${this.config.port}`)

      if (debug) {
        log.info(`[TLSNotary] Public key: ${this.ffi.getPublicKeyHex()}`)
        log.info("[TLSNotary] Waiting for prover connections...")
      }

      if (proxyEnabled) {
        log.warning("[TLSNotary] DEBUG PROXY ENABLED - All incoming data will be logged!")
      }
    } catch (error) {
      log.error(`[TLSNotary] Failed to start FFI server on port ${this.config.port}: ${error}`)
      if (fatal) {
        log.error("[TLSNotary] FATAL: Exiting due to server start failure")
        process.exit(1)
      }
      throw error
    }
  }

  /**
   * Start with a debug proxy that logs all incoming data
   * The proxy listens on the configured port and forwards to Rust on port+1
   * @private
   */
  private async startWithProxy(): Promise<void> {
    const net = await import("net")
    const publicPort = this.config.port
    const rustPort = this.config.port + 1

    // Start Rust server on internal port
    await this.ffi!.startServer(rustPort)
    log.info(`[TLSNotary] Rust server started on internal port ${rustPort}`)

    // Close any previous proxy server (defensive)
    if (this.proxyServer) {
      try {
        await new Promise<void>((resolve, reject) => {
          this.proxyServer!.once("error", reject)
          this.proxyServer!.close((err) => (err ? reject(err) : resolve()))
        })
      } catch {
        // ignore
      }
      this.proxyServer = null
    }

    // Create proxy server on public port
    this.proxyServer = net.createServer((clientSocket) => {
      const clientAddr = `${clientSocket.remoteAddress}:${clientSocket.remotePort}`
      log.info(`[TLSNotary-Proxy] New connection from ${clientAddr}`)

      // Connect to Rust server
      const rustSocket = net.connect(rustPort, "127.0.0.1", () => {
        log.debug(`[TLSNotary-Proxy] Connected to Rust server for ${clientAddr}`)
      })

      // Log and forward data from client to Rust
      clientSocket.on("data", (data) => {
        const preview = data.slice(0, 500).toString("utf-8")
        const hexPreview = data.slice(0, 100).toString("hex")
        log.info(`[TLSNotary-Proxy] <<< FROM ${clientAddr} (${data.length} bytes):`)
        log.info(`[TLSNotary-Proxy] Text: ${preview}`)
        log.info(`[TLSNotary-Proxy] Hex:  ${hexPreview}`)
        rustSocket.write(data)
      })

      // Forward data from Rust to client (no logging needed)
      rustSocket.on("data", (data) => {
        clientSocket.write(data)
      })

      // Handle errors and close
      clientSocket.on("error", (err) => {
        log.warning(`[TLSNotary-Proxy] Client error ${clientAddr}: ${err.message}`)
        rustSocket.destroy()
      })

      rustSocket.on("error", (err) => {
        log.warning(`[TLSNotary-Proxy] Rust connection error for ${clientAddr}: ${err.message}`)
        clientSocket.destroy()
      })

      clientSocket.on("close", () => {
        log.debug(`[TLSNotary-Proxy] Client ${clientAddr} disconnected`)
        rustSocket.destroy()
      })

      rustSocket.on("close", () => {
        clientSocket.destroy()
      })
    })

    await new Promise<void>((resolve, reject) => {
      this.proxyServer!.once("error", reject)
      this.proxyServer!.listen(publicPort, () => {
        log.info(`[TLSNotary-Proxy] Listening on port ${publicPort}, forwarding to ${rustPort}`)
        resolve()
      })
    })
  }

  /**
   * Stop the notary WebSocket server
   * In Docker mode, this is a no-op as the container is managed externally
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return
    }

    const mode = this.getMode()

    if (mode === "docker") {
      // In Docker mode, we don't control the container lifecycle
      // Just mark as not running from our perspective
      this.running = false
      log.info("[TLSNotary] Docker mode - marked as stopped (container still running)")
      return
    }

    // FFI mode
    if (!this.ffi) {
      return
    }

    // Close the proxy server if it exists
    if (this.proxyServer) {
      try {
        this.proxyServer.close()
      } catch {
        // ignore
      }
      this.proxyServer = null
    }

    await this.ffi.stopServer()
    this.running = false
    log.info("[TLSNotary] Server stopped")
  }

  /**
   * Shutdown the service completely
   * Stops the server and releases all resources
   * In Docker mode, only clears local state (container managed externally)
   */
  async shutdown(): Promise<void> {
    await this.stop()

    const mode = this.getMode()

    if (mode === "docker") {
      this.dockerPublicKey = null
      log.info("[TLSNotary] Docker mode - service shutdown complete (container still running)")
      return
    }

    // FFI mode
    if (this.ffi) {
      this.ffi.destroy()
      this.ffi = null
    }

    log.info("[TLSNotary] Service shutdown complete")
  }

  /**
   * Verify an attestation
   * @param attestation - Serialized attestation bytes (Uint8Array or base64 string)
   * @returns Verification result
   * @note In Docker mode, verification is not yet supported (attestations are verified client-side)
   */
  verify(attestation: Uint8Array | string): VerificationResult {
    const mode = this.getMode()

    if (mode === "docker") {
      // Docker notary-server handles verification internally
      // Client-side tlsn-js also verifies attestations
      // For now, we don't have a way to verify via HTTP API
      return {
        success: false,
        error: "Verification not supported in Docker mode - use client-side verification",
      }
    }

    // FFI mode
    if (!this.ffi) {
      return {
        success: false,
        error: "Service not initialized",
      }
    }

    let attestationBytes: Uint8Array
    if (typeof attestation === "string") {
      // Assume base64 encoded
      attestationBytes = Buffer.from(attestation, "base64")
    } else {
      attestationBytes = attestation
    }

    return this.ffi.verifyAttestation(attestationBytes)
  }

  /**
   * Get the notary's public key as bytes
   * @returns Compressed secp256k1 public key (33 bytes)
   * @throws Error if service not initialized
   */
  getPublicKey(): Uint8Array {
    const mode = this.getMode()

    if (mode === "docker") {
      if (!this.dockerPublicKey) {
        throw new Error("Docker public key not available - service not started")
      }
      // Convert hex string to Uint8Array
      return Buffer.from(this.dockerPublicKey, "hex")
    }

    // FFI mode
    if (!this.ffi) {
      throw new Error("Service not initialized")
    }
    return this.ffi.getPublicKey()
  }

  /**
   * Get the notary's public key as hex string
   * @returns Hex-encoded compressed public key
   * @throws Error if service not initialized
   */
  getPublicKeyHex(): string {
    const mode = this.getMode()

    if (mode === "docker") {
      if (!this.dockerPublicKey) {
        throw new Error("Docker public key not available - service not started")
      }
      return this.dockerPublicKey
    }

    // FFI mode
    if (!this.ffi) {
      throw new Error("Service not initialized")
    }
    return this.ffi.getPublicKeyHex()
  }

  /**
   * Get the configured port
   */
  getPort(): number {
    return this.config.port
  }

  /**
   * Check if the service is running
   */
  isRunning(): boolean {
    return this.running
  }

  /**
   * Check if the service is initialized
   */
  isInitialized(): boolean {
    const mode = this.getMode()

    if (mode === "docker") {
      return this.dockerPublicKey !== null
    }

    return this.ffi !== null
  }

  /**
   * Get full service status
   * @returns Service status object
   */
  getStatus(): TLSNotaryServiceStatus {
    const mode = this.getMode()

    let health: NotaryHealthStatus

    if (mode === "docker") {
      health = {
        healthy: this.running && this.dockerPublicKey !== null,
        initialized: this.dockerPublicKey !== null,
        serverRunning: this.running,
        error: this.running ? undefined : "Docker container not accessible",
      }
    } else {
      health = this.ffi
        ? this.ffi.getHealthStatus()
        : {
          healthy: false,
          initialized: false,
          serverRunning: false,
          error: "Service not initialized",
        }
    }

    return {
      enabled: true,
      running: this.running,
      port: this.config.port,
      health,
      mode, // Include mode in status
    }
  }

  /**
   * Health check for the service
   * @returns True if service is healthy
   */
  isHealthy(): boolean {
    const mode = this.getMode()

    if (mode === "docker") {
      return this.running && this.dockerPublicKey !== null
    }

    // FFI mode
    if (!this.ffi) {
      return false
    }
    return this.ffi.getHealthStatus().healthy
  }
}

// Export singleton management
let serviceInstance: TLSNotaryService | null = null

/**
 * Get or create the global TLSNotaryService instance
 * Uses environment configuration
 * @returns Service instance or null if not enabled
 */
export function getTLSNotaryService(): TLSNotaryService | null {
  if (serviceInstance === null) {
    serviceInstance = TLSNotaryService.fromEnvironment()
  }
  return serviceInstance
}

/**
 * Initialize and start the global TLSNotaryService
 * @returns Service instance or null if not enabled
 */
export async function initializeTLSNotaryService(): Promise<TLSNotaryService | null> {
  const service = getTLSNotaryService()
  if (service && !service.isInitialized()) {
    await service.initialize()
  }
  return service
}

/**
 * Shutdown the global TLSNotaryService
 */
export async function shutdownTLSNotaryService(): Promise<void> {
  if (serviceInstance) {
    await serviceInstance.shutdown()
    serviceInstance = null
  }
}

export default TLSNotaryService
