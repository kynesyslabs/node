/**
 * OmniProtocol Key Management Integration
 *
 * This module integrates OmniProtocol with the node's existing key management.
 * It provides helper functions to get the node's keys for signing authenticated messages.
 */

import { getSharedState } from "src/utilities/sharedState"
import { uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"

/**
 * Get the node's Ed25519 private key as Buffer
 * @returns Private key buffer or null if not available
 */
export function getNodePrivateKey(): Buffer | null {
    try {
        const keypair = getSharedState.keypair

        if (!keypair || !keypair.privateKey) {
            console.warn("[OmniProtocol] Node private key not available")
            return null
        }

        // Convert Uint8Array to Buffer
        if (keypair.privateKey instanceof Uint8Array) {
            return Buffer.from(keypair.privateKey)
        }

        // If already a Buffer
        if (Buffer.isBuffer(keypair.privateKey)) {
            return keypair.privateKey
        }

        console.warn("[OmniProtocol] Private key is in unexpected format")
        return null
    } catch (error) {
        console.error("[OmniProtocol] Error getting node private key:", error)
        return null
    }
}

/**
 * Get the node's Ed25519 public key as Buffer
 * @returns Public key buffer or null if not available
 */
export function getNodePublicKey(): Buffer | null {
    try {
        const keypair = getSharedState.keypair

        if (!keypair || !keypair.publicKey) {
            console.warn("[OmniProtocol] Node public key not available")
            return null
        }

        // Convert Uint8Array to Buffer
        if (keypair.publicKey instanceof Uint8Array) {
            return Buffer.from(keypair.publicKey)
        }

        // If already a Buffer
        if (Buffer.isBuffer(keypair.publicKey)) {
            return keypair.publicKey
        }

        console.warn("[OmniProtocol] Public key is in unexpected format")
        return null
    } catch (error) {
        console.error("[OmniProtocol] Error getting node public key:", error)
        return null
    }
}

/**
 * Get the node's identity (hex-encoded public key)
 * @returns Identity string or null if not available
 */
export function getNodeIdentity(): string | null {
    try {
        const publicKey = getNodePublicKey()
        if (!publicKey) {
            return null
        }
        return publicKey.toString("hex")
    } catch (error) {
        console.error("[OmniProtocol] Error getting node identity:", error)
        return null
    }
}

/**
 * Check if the node has keys configured
 * @returns True if keys are available, false otherwise
 */
export function hasNodeKeys(): boolean {
    const privateKey = getNodePrivateKey()
    const publicKey = getNodePublicKey()
    return privateKey !== null && publicKey !== null
}

/**
 * Validate that keys are Ed25519 format (32-byte public key, 64-byte private key)
 * @returns True if keys are valid Ed25519 format
 */
export function validateNodeKeys(): boolean {
    const privateKey = getNodePrivateKey()
    const publicKey = getNodePublicKey()

    if (!privateKey || !publicKey) {
        return false
    }

    // Ed25519 keys must be specific sizes
    const validPublicKey = publicKey.length === 32
    const validPrivateKey = privateKey.length === 64 || privateKey.length === 32 // Can be 32 or 64 bytes

    if (!validPublicKey || !validPrivateKey) {
        console.warn(
            `[OmniProtocol] Invalid key sizes: publicKey=${publicKey.length} bytes, privateKey=${privateKey.length} bytes`
        )
        return false
    }

    return true
}
