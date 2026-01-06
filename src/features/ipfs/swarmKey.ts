/**
 * IPFS Swarm Key Utilities for Demos Network
 *
 * Provides utilities for generating and managing swarm keys used to create
 * a private IPFS network isolated from the public IPFS network.
 *
 * @fileoverview IPFS swarm key generation and management
 *
 * REVIEW: Phase 4 - Private Network Implementation
 */

import { randomBytes } from "crypto"
import log from "src/utilities/logger"

// ============================================================================
// Constants
// ============================================================================

/**
 * Swarm key format identifier used by go-ipfs/kubo
 * See: https://github.com/Kubuxu/go-ipfs-swarm-key-gen
 */
const SWARM_KEY_HEADER = "/key/swarm/psk/1.0.0/\n"
const SWARM_KEY_CODEC = "/base16/\n"
const SWARM_KEY_LENGTH = 32 // 32 bytes = 256 bits

/**
 * Official Demos Network IPFS Swarm Key
 *
 * This key defines the Demos private IPFS network. All Demos nodes use this
 * same key to form an isolated IPFS swarm for performance optimization.
 *
 * Security Note: This key is intentionally public. It only controls IPFS
 * network membership, not Demos blockchain access (which requires authentication).
 * Making it public allows anyone to join the IPFS layer, but:
 * - Writing (pinning) still requires DEM tokens via Demos transactions
 * - Blockchain operations still require valid Demos identity
 * - Content is public anyway (blockchain transparency)
 *
 * The key provides performance isolation from the public IPFS network,
 * not security isolation.
 *
 * Generated: 2026-01-06
 */
export const DEMOS_IPFS_SWARM_KEY = "1d8b2cfa0ee76011ab655cec98be549f3f5cd81199b1670003ec37c0db0592e4"

/**
 * Get the formatted swarm.key file content for Demos network
 * Ready to write directly to ~/.ipfs/swarm.key or pass to Kubo
 */
export const DEMOS_IPFS_SWARM_KEY_FILE = formatSwarmKeyFileContent(DEMOS_IPFS_SWARM_KEY)

/**
 * Internal helper to format key without circular dependency
 */
function formatSwarmKeyFileContent(hexKey: string): string {
    return `${SWARM_KEY_HEADER}${SWARM_KEY_CODEC}${hexKey.toLowerCase()}\n`
}

// ============================================================================
// Swarm Key Generation
// ============================================================================

/**
 * Generate a new random swarm key for private IPFS network
 *
 * The swarm key is a 32-byte (256-bit) random key that must be shared
 * among all nodes in the private network. Nodes with different swarm keys
 * cannot communicate.
 *
 * @returns Hex-encoded swarm key (64 characters)
 *
 * @example
 * ```typescript
 * const key = generateSwarmKey()
 * console.log(key) // "a1b2c3d4..." (64 hex characters)
 * ```
 */
export function generateSwarmKey(): string {
    const keyBytes = randomBytes(SWARM_KEY_LENGTH)
    return keyBytes.toString("hex")
}

/**
 * Format swarm key for writing to IPFS swarm.key file
 *
 * The swarm.key file format used by go-ipfs/kubo:
 * ```
 * /key/swarm/psk/1.0.0/
 * /base16/
 * <64 hex characters>
 * ```
 *
 * @param hexKey - 64-character hex-encoded swarm key
 * @returns Formatted swarm key file content
 *
 * @example
 * ```typescript
 * const key = generateSwarmKey()
 * const fileContent = formatSwarmKeyFile(key)
 * fs.writeFileSync('/path/to/.ipfs/swarm.key', fileContent)
 * ```
 */
export function formatSwarmKeyFile(hexKey: string): string {
    if (!isValidSwarmKey(hexKey)) {
        throw new Error("Invalid swarm key: must be 64 hex characters")
    }
    return `${SWARM_KEY_HEADER}${SWARM_KEY_CODEC}${hexKey.toLowerCase()}\n`
}

/**
 * Parse swarm key from file content
 *
 * @param fileContent - Content of swarm.key file
 * @returns Hex-encoded swarm key
 * @throws Error if file format is invalid
 */
export function parseSwarmKeyFile(fileContent: string): string {
    const lines = fileContent.trim().split("\n")

    if (lines.length < 3) {
        throw new Error("Invalid swarm.key file: expected 3 lines")
    }

    const header = lines[0] + "\n"
    const codec = lines[1] + "\n"
    const key = lines[2].trim()

    if (header !== SWARM_KEY_HEADER) {
        throw new Error(`Invalid swarm.key header: expected "${SWARM_KEY_HEADER.trim()}"`)
    }

    if (codec !== SWARM_KEY_CODEC) {
        throw new Error(`Invalid swarm.key codec: expected "${SWARM_KEY_CODEC.trim()}"`)
    }

    if (!isValidSwarmKey(key)) {
        throw new Error("Invalid swarm.key: key must be 64 hex characters")
    }

    return key.toLowerCase()
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate a swarm key string
 *
 * @param key - Swarm key to validate
 * @returns true if key is valid (64 hex characters)
 */
export function isValidSwarmKey(key: string): boolean {
    if (!key || typeof key !== "string") {
        return false
    }

    // Must be exactly 64 hex characters (32 bytes)
    return /^[0-9a-fA-F]{64}$/.test(key)
}

/**
 * Validate that two nodes share the same swarm key
 *
 * @param key1 - First swarm key
 * @param key2 - Second swarm key
 * @returns true if keys match (case-insensitive)
 */
export function swarmKeysMatch(key1: string, key2: string): boolean {
    if (!isValidSwarmKey(key1) || !isValidSwarmKey(key2)) {
        return false
    }
    return key1.toLowerCase() === key2.toLowerCase()
}

// ============================================================================
// Environment Integration
// ============================================================================

/**
 * Get the active swarm key for this node
 *
 * Priority:
 * 1. DEMOS_IPFS_SWARM_KEY env var (for custom/test networks)
 * 2. Built-in DEMOS_IPFS_SWARM_KEY constant (default Demos network)
 *
 * @returns Swarm key (always returns a valid key - defaults to Demos network key)
 */
export function getSwarmKey(): string {
    const envKey = process.env.DEMOS_IPFS_SWARM_KEY

    if (envKey) {
        if (!isValidSwarmKey(envKey)) {
            log.warning("[IPFS] DEMOS_IPFS_SWARM_KEY env var is invalid, using default Demos key")
            return DEMOS_IPFS_SWARM_KEY
        }
        log.debug("[IPFS] Using custom swarm key from environment")
        return envKey.toLowerCase()
    }

    // Default to the official Demos network key
    return DEMOS_IPFS_SWARM_KEY
}

/**
 * @deprecated Use getSwarmKey() instead - now always returns a key
 */
export function getSwarmKeyFromEnv(): string | undefined {
    return getSwarmKey()
}

/**
 * Check if private network mode is enabled
 *
 * With the built-in Demos swarm key, private network is ALWAYS enabled
 * unless explicitly disabled via DEMOS_IPFS_PUBLIC_MODE=true
 *
 * @returns true if private network mode is enabled (default: true)
 */
export function isPrivateNetworkEnabled(): boolean {
    // Only disable private network if explicitly requested
    if (process.env.DEMOS_IPFS_PUBLIC_MODE === "true") {
        return false
    }
    // Private network is now the default
    return true
}

/**
 * Log swarm key status (without exposing the actual key)
 */
export function logSwarmKeyStatus(): void {
    const swarmKey = getSwarmKey()
    const isCustom = process.env.DEMOS_IPFS_SWARM_KEY !== undefined
    const isPublicMode = process.env.DEMOS_IPFS_PUBLIC_MODE === "true"

    if (isPublicMode) {
        log.info("[IPFS] Running in PUBLIC mode (connected to public IPFS network)")
        return
    }

    // Only log first 8 and last 8 characters for identification
    const masked = `${swarmKey.slice(0, 8)}...${swarmKey.slice(-8)}`

    if (isCustom) {
        log.info(`[IPFS] Using CUSTOM swarm key: ${masked}`)
    } else {
        log.info(`[IPFS] Using Demos network swarm key: ${masked}`)
    }
}
