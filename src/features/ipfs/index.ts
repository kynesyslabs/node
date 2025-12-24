/**
 * IPFS Integration for Demos Network
 *
 * This module provides IPFS (InterPlanetary File System) integration for Demos nodes,
 * enabling decentralized file storage and P2P content distribution with full
 * blockchain integration.
 *
 * Architecture:
 * - Infrastructure: Kubo v0.26.0 via Docker Compose (internal network)
 * - Reads: demosCall (gas-free) → ipfs_get, ipfs_pins, ipfs_status
 * - Writes: Demos Transactions → IPFS_ADD, IPFS_PIN, IPFS_UNPIN
 * - State: Account-level ipfs_pins field in StateDB
 * - Economics: Full tokenomics (pay to pin, earn to host)
 *
 * @fileoverview Main exports for Demos Network IPFS integration
 *
 * @example
 * ```typescript
 * import { IPFSManager, createIPFSManager } from "@/features/ipfs"
 *
 * // Create and initialize manager
 * const ipfs = createIPFSManager({ debug: true })
 * await ipfs.initialize()
 *
 * // Check health
 * const health = await ipfs.healthCheck()
 * if (health.healthy) {
 *   console.log(`IPFS node ${health.peerId} is healthy`)
 * }
 * ```
 */

// Core IPFS manager
export { IPFSManager } from "./IPFSManager"

// Types
export type {
    IpfsManagerConfig,
    IpfsNodeInfo,
    IpfsHealthStatus,
    IpfsPin,
    AccountIpfsState,
} from "./types"

export { IPFS_DEFAULTS } from "./types"

// Errors
export {
    IPFSError,
    IPFSConnectionError,
    IPFSTimeoutError,
    IPFSNotFoundError,
    IPFSInvalidCIDError,
    IPFSAPIError,
    IPFS_ERROR_CODES,
} from "./errors"

// =========================================================================
// Factory Functions
// =========================================================================

import { IPFSManager } from "./IPFSManager"
import type { IpfsManagerConfig } from "./types"

/**
 * Create a new IPFSManager instance with optional configuration
 *
 * Factory function for convenient instantiation with defaults.
 *
 * @param config - Optional configuration overrides
 * @returns New IPFSManager instance
 *
 * @example
 * ```typescript
 * // Default configuration (connects to demos-ipfs:5001)
 * const ipfs = createIPFSManager()
 *
 * // Custom configuration
 * const ipfs = createIPFSManager({
 *   apiUrl: "http://localhost:5001",
 *   timeout: 60000,
 *   debug: true
 * })
 * ```
 */
export function createIpfsManager(config?: Partial<IpfsManagerConfig>): IPFSManager {
    return new IPFSManager(config)
}
