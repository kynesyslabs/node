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
 * Get swarm key from environment variable
 *
 * @returns Swarm key from DEMOS_IPFS_SWARM_KEY env var, or undefined
 */
export function getSwarmKeyFromEnv(): string | undefined {
    const key = process.env.DEMOS_IPFS_SWARM_KEY
    if (!key) {
        return undefined
    }

    if (!isValidSwarmKey(key)) {
        log.warning("[IPFS] DEMOS_IPFS_SWARM_KEY is invalid (must be 64 hex characters)")
        return undefined
    }

    return key.toLowerCase()
}

/**
 * Check if private network mode is enabled
 *
 * Private network is enabled when:
 * 1. DEMOS_IPFS_SWARM_KEY is set and valid, OR
 * 2. LIBP2P_FORCE_PNET=1 is set
 *
 * @returns true if private network mode is enabled
 */
export function isPrivateNetworkEnabled(): boolean {
    const swarmKey = getSwarmKeyFromEnv()
    const forcePnet = process.env.LIBP2P_FORCE_PNET === "1"

    return !!swarmKey || forcePnet
}

/**
 * Log swarm key status (without exposing the actual key)
 */
export function logSwarmKeyStatus(): void {
    const swarmKey = getSwarmKeyFromEnv()
    const forcePnet = process.env.LIBP2P_FORCE_PNET === "1"

    if (swarmKey) {
        // Only log first 8 and last 8 characters for identification
        const masked = `${swarmKey.slice(0, 8)}...${swarmKey.slice(-8)}`
        log.info(`[IPFS] Swarm key configured: ${masked}`)
    } else if (forcePnet) {
        log.warning("[IPFS] LIBP2P_FORCE_PNET=1 but no swarm key configured")
    } else {
        log.debug("[IPFS] No swarm key configured (public IPFS mode)")
    }
}
