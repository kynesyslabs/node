/**
 * TLSNotary FFI Bindings for Demos Node
 *
 * Uses bun:ffi to interface with the Rust TLSNotary library.
 * Adapted from reference implementation at demos_tlsnotary/node/ts/TLSNotary.ts
 *
 * @module features/tlsnotary/ffi
 */

// REVIEW: TLSNotary FFI bindings - new feature for HTTPS attestation
import { dlopen, FFIType, ptr, toArrayBuffer, CString } from "bun:ffi"
import { join, dirname } from "path"
import type { NotaryConfig, VerificationResult, NotaryHealthStatus } from "./types"
import {
  SIGNING_KEY_BYTES,
  PUBLIC_KEY_BYTES,
  DEFAULT_NOTARY_PORT,
  DEFAULT_MAX_SENT_DATA,
  DEFAULT_MAX_RECV_DATA,
  FFI_CONFIG_BUFFER_SIZE,
} from "./constants"

// Re-export types for backward compatibility
export type { NotaryConfig, VerificationResult, NotaryHealthStatus } from "./types"

// ============================================================================
// FFI Bindings
// ============================================================================

/**
 * Get the path to the native TLSNotary library
 * @returns Path to the shared library
 */
function getLibraryPath(): string {
  // Library is stored in libs/tlsn/ at project root
  // __dirname equivalent for ESM
  const currentDir = dirname(new URL(import.meta.url).pathname)
  // Navigate from src/features/tlsnotary to project root
  const projectRoot = join(currentDir, "../../..")
  const libDir = join(projectRoot, "libs/tlsn")

  switch (process.platform) {
    case "darwin":
      return join(libDir, "libtlsn_notary.dylib")
    case "win32":
      return join(libDir, "tlsn_notary.dll")
    default:
      // Linux and other Unix-like systems
      return join(libDir, "libtlsn_notary.so")
  }
}

/**
 * FFI symbols exported by the Rust library
 */
const symbols = {
  tlsn_init: {
    args: [] as const,
    returns: FFIType.i32,
  },
  tlsn_notary_create: {
    args: [FFIType.ptr] as const, // NotaryConfigFFI*
    returns: FFIType.ptr, // NotaryHandle*
  },
  tlsn_notary_start_server: {
    args: [FFIType.ptr, FFIType.u16] as const,
    returns: FFIType.i32,
  },
  tlsn_notary_stop_server: {
    args: [FFIType.ptr] as const,
    returns: FFIType.i32,
  },
  tlsn_verify_attestation: {
    args: [FFIType.ptr, FFIType.u64] as const,
    returns: FFIType.ptr, // VerificationResultFFI*
  },
  tlsn_notary_get_public_key: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64] as const,
    returns: FFIType.i32,
  },
  tlsn_notary_destroy: {
    args: [FFIType.ptr] as const,
    returns: FFIType.void,
  },
  tlsn_free_verification_result: {
    args: [FFIType.ptr] as const,
    returns: FFIType.void,
  },
  tlsn_free_string: {
    args: [FFIType.ptr] as const,
    returns: FFIType.void,
  },
} as const

// Type for the loaded library
type TLSNLibrary = ReturnType<typeof dlopen<typeof symbols>>;

// ============================================================================
// TLSNotaryFFI Class
// ============================================================================

/**
 * Low-level FFI wrapper for the TLSNotary Rust library
 *
 * This class handles the raw FFI calls and memory management.
 * Use TLSNotaryService for the high-level service interface.
 *
 * @example
 * ```typescript
 * import { TLSNotaryFFI } from '@/features/tlsnotary/ffi';
 *
 * const ffi = new TLSNotaryFFI({
 *   signingKey: new Uint8Array(32), // Your 32-byte secp256k1 private key
 *   maxSentData: 16384,
 *   maxRecvData: 65536,
 * });
 *
 * // Start WebSocket server for browser provers
 * await ffi.startServer(7047);
 *
 * // Verify an attestation
 * const result = ffi.verifyAttestation(attestationBytes);
 *
 * // Cleanup
 * ffi.destroy();
 * ```
 */
export class TLSNotaryFFI {
  private lib: TLSNLibrary
  private handle: number | null = null
  private initialized = false
  private serverRunning = false
  private readonly config: NotaryConfig
  // Strong references to buffers passed to native code to prevent GC
  private _signingKey: Uint8Array | null = null
  private _configBuffer: Uint8Array | null = null

  /**
   * Create a new TLSNotary FFI instance
   * @param config - Notary configuration
   * @throws Error if signing key is invalid or library fails to load
   */
  constructor(config: NotaryConfig) {
    // Validate signing key
    if (!config.signingKey || config.signingKey.length !== SIGNING_KEY_BYTES) {
      throw new Error(`signingKey must be exactly ${SIGNING_KEY_BYTES} bytes`)
    }

    this.config = config

    // Load the native library
    const libPath = getLibraryPath()
    try {
      this.lib = dlopen(libPath, symbols)
    } catch (error) {
      throw new Error(
        `Failed to load TLSNotary library from ${libPath}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    // Initialize the library
    const initResult = this.lib.symbols.tlsn_init()
    if (initResult !== 0) {
      throw new Error(`Failed to initialize TLSNotary library: error code ${initResult}`)
    }

    // Create notary instance
    this.createNotary()
  }

  /**
   * Create the native notary instance
   * @private
   */
  private createNotary(): void {
    // Build FFI config struct
    // NotaryConfigFFI layout (40 bytes):
    //   signing_key: *const u8 (8 bytes)
    //   signing_key_len: usize (8 bytes)
    //   max_sent_data: usize (8 bytes)
    //   max_recv_data: usize (8 bytes)
    //   server_port: u16 (2 bytes + 6 padding)

    const configBuffer = new ArrayBuffer(FFI_CONFIG_BUFFER_SIZE)
    const configView = new DataView(configBuffer)

    // Store strong reference to signing key to prevent GC while native code holds pointer
    this._signingKey = this.config.signingKey
    const signingKeyPtr = ptr(this._signingKey)

    // Write struct fields (little-endian)
    configView.setBigUint64(0, BigInt(signingKeyPtr), true) // signing_key ptr
    configView.setBigUint64(8, BigInt(SIGNING_KEY_BYTES), true) // signing_key_len
    configView.setBigUint64(16, BigInt(this.config.maxSentData ?? DEFAULT_MAX_SENT_DATA), true) // max_sent_data
    configView.setBigUint64(24, BigInt(this.config.maxRecvData ?? DEFAULT_MAX_RECV_DATA), true) // max_recv_data
    configView.setUint16(32, 0, true) // server_port (0 = don't auto-start)

    // Store strong reference to config buffer to prevent GC
    this._configBuffer = new Uint8Array(configBuffer)
    const configPtr = ptr(this._configBuffer)
    this.handle = this.lib.symbols.tlsn_notary_create(configPtr) as number

    if (this.handle === 0 || this.handle === null) {
      throw new Error("Failed to create Notary instance")
    }

    this.initialized = true
  }

  /**
   * Start the WebSocket server for accepting prover connections
   * @param port - Port to listen on (default: 7047)
   * @throws Error if notary not initialized or server fails to start
   */
  async startServer(port = DEFAULT_NOTARY_PORT): Promise<void> {
    if (!this.initialized || !this.handle) {
      throw new Error("Notary not initialized")
    }

    if (this.serverRunning) {
      throw new Error("Server already running")
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = this.lib.symbols.tlsn_notary_start_server(this.handle as any, port)

    if (result !== 0) {
      throw new Error(`Failed to start server: error code ${result}`)
    }

    this.serverRunning = true
  }

  /**
   * Stop the WebSocket server
   */
  async stopServer(): Promise<void> {
    if (!this.initialized || !this.handle) {
      return
    }

    if (!this.serverRunning) {
      return
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.lib.symbols.tlsn_notary_stop_server(this.handle as any)
    this.serverRunning = false
  }

  /**
   * Verify an attestation/presentation
   * @param attestation - Serialized attestation bytes
   * @returns Verification result with success status and metadata
   */
  verifyAttestation(attestation: Uint8Array): VerificationResult {
    if (!this.initialized) {
      return {
        success: false,
        error: "Notary not initialized",
      }
    }

    // Handle empty attestation before FFI call (bun:ffi can't handle empty buffers)
    if (attestation.length === 0) {
      return {
        success: false,
        error: "Invalid attestation data: empty buffer",
      }
    }

    const attestationPtr = ptr(attestation)
    const resultPtr = this.lib.symbols.tlsn_verify_attestation(attestationPtr, BigInt(attestation.length))

    if (resultPtr === 0 || resultPtr === null) {
      return {
        success: false,
        error: "Verification returned null",
      }
    }

    try {
      // Read VerificationResultFFI struct (40 bytes)
      // Layout:
      //   status: i32 (4 bytes + 4 padding)
      //   server_name: *mut c_char (8 bytes)
      //   connection_time: u64 (8 bytes)
      //   sent_len: u32 (4 bytes)
      //   recv_len: u32 (4 bytes)
      //   error_message: *mut c_char (8 bytes)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resultBuffer = toArrayBuffer(resultPtr as any, 0, 40)
      const view = new DataView(resultBuffer)

      const status = view.getInt32(0, true)
      const serverNamePtr = view.getBigUint64(8, true)
      const connectionTime = view.getBigUint64(16, true)
      const sentLen = view.getUint32(24, true)
      const recvLen = view.getUint32(28, true)
      const errorMessagePtr = view.getBigUint64(32, true)

      let serverName: string | undefined
      if (serverNamePtr !== 0n) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        serverName = new CString(Number(serverNamePtr) as any).toString()
      }

      let errorMessage: string | undefined
      if (errorMessagePtr !== 0n) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        errorMessage = new CString(Number(errorMessagePtr) as any).toString()
      }

      if (status === 0) {
        return {
          success: true,
          serverName,
          connectionTime: Number(connectionTime),
          sentLength: sentLen,
          recvLength: recvLen,
        }
      } else {
        return {
          success: false,
          error: errorMessage ?? `Verification failed with status ${status}`,
        }
      }
    } finally {
      // Free the result struct
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.lib.symbols.tlsn_free_verification_result(resultPtr as any)
    }
  }

  /**
   * Get the notary's compressed public key (33 bytes)
   * Share this with the SDK so clients can verify attestations
   * @returns Compressed secp256k1 public key
   * @throws Error if notary not initialized or key retrieval fails
   */
  getPublicKey(): Uint8Array {
    if (!this.initialized || !this.handle) {
      throw new Error("Notary not initialized")
    }

    const keyBuffer = new Uint8Array(PUBLIC_KEY_BYTES)
    const keyPtr = ptr(keyBuffer)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = this.lib.symbols.tlsn_notary_get_public_key(
      this.handle as any,
      keyPtr,
      BigInt(PUBLIC_KEY_BYTES),
    )

    if (result < 0) {
      throw new Error(`Failed to get public key: error code ${result}`)
    }

    return keyBuffer.slice(0, result)
  }

  /**
   * Get the public key as a hex-encoded string
   * @returns Hex-encoded compressed public key
   */
  getPublicKeyHex(): string {
    const key = this.getPublicKey()
    return Buffer.from(key).toString("hex")
  }

  /**
   * Get health status of the notary
   * @returns Health status object
   */
  getHealthStatus(): NotaryHealthStatus {
    if (!this.initialized) {
      return {
        healthy: false,
        initialized: false,
        serverRunning: false,
        error: "Notary not initialized",
      }
    }

    try {
      const publicKey = this.getPublicKeyHex()
      return {
        healthy: true,
        initialized: this.initialized,
        serverRunning: this.serverRunning,
        publicKey,
      }
    } catch (error) {
      return {
        healthy: false,
        initialized: this.initialized,
        serverRunning: this.serverRunning,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * Cleanup and release resources
   * Call this when shutting down the notary
   */
  destroy(): void {
    if (this.handle) {
      // Best-effort stop if server is still running
      if (this.serverRunning) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          this.lib.symbols.tlsn_notary_stop_server(this.handle as any)
        } finally {
          this.serverRunning = false
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.lib.symbols.tlsn_notary_destroy(this.handle as any)
      this.handle = null
    }
    // Clear buffer references after native handle is released
    this._signingKey = null
    this._configBuffer = null
    this.initialized = false
    this.serverRunning = false
  }

  /**
   * Check if the notary is initialized
   */
  isInitialized(): boolean {
    return this.initialized
  }

  /**
   * Check if the server is running
   */
  isServerRunning(): boolean {
    return this.serverRunning
  }
}

export default TLSNotaryFFI
