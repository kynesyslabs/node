/**
 * Signature Verification Utility
 *
 * Shared signature verification logic for both rate limiter middleware
 * and RPC route handlers. Supports ed25519, falcon, and ml-dsa algorithms.
 */

import { ucrypto, hexToUint8Array } from "@kynesyslabs/demosdk/encryption"
import { Ed25519SignedObject, signedObject } from "@kynesyslabs/demosdk/types"
import log from "src/utilities/logger"

export interface VerificationResult {
    /**
     * Whether the signature is valid
     */
    valid: boolean

    /**
     * The full identity string (e.g., "ed25519:abc123...")
     */
    identity: string | null

    /**
     * The public key portion (hex string without algorithm prefix)
     */
    publicKey: string | null

    /**
     * The signature algorithm used
     */
    algorithm: string | null

    /**
     * Error message if verification failed
     */
    error?: string
}

const SUPPORTED_ALGORITHMS = ["ed25519", "falcon", "ml-dsa"]

/**
 * Normalize a public key by removing 0x prefix if present
 * Does NOT change case - crypto operations need original case preserved
 */
function normalizePublicKey(key: string): string {
    return key.replace(/^0x/i, "")
}

/**
 * Verify a signature from request headers
 *
 * Matches the logic in validateIdentityHeaders from server_rpc.ts:
 * - For "algorithm:publicKey" format: message = publicKey hex (splits[1])
 * - For plain identity format: message = full identity string
 *
 * @param identity - The identity header value (e.g., "ed25519:abc123..." or plain hex)
 * @param signature - The signature header value (hex encoded)
 * @returns Verification result with identity details
 */
export async function verifySignature(
    identity: string,
    signature: string,
): Promise<VerificationResult> {
    if (!identity || !signature) {
        return {
            valid: false,
            identity: null,
            publicKey: null,
            algorithm: null,
            error: "Missing identity or signature",
        }
    }

    try {
        const splits = identity.split(":")
        let signatureObj: signedObject
        let algorithm: string
        let publicKeyHex: string // The raw hex for crypto operations (no normalization)
        let publicKeyForWhitelist: string // Normalized for whitelist comparison

        if (splits.length > 1 && SUPPORTED_ALGORITHMS.includes(splits[0])) {
            // Format: "algorithm:publicKeyHex"
            algorithm = splits[0]
            publicKeyHex = splits[1] // Use raw value for crypto
            publicKeyForWhitelist = normalizePublicKey(splits[1]) // Normalize for whitelist

            const publicKeyBytes = hexToUint8Array(publicKeyHex)
            const signatureBytes = hexToUint8Array(signature)

            signatureObj = {
                algorithm: algorithm,
                signature: signatureBytes,
                // Message is the public key hex portion (splits[1]), matching validateIdentityHeaders
                message: new TextEncoder().encode(publicKeyHex),
                publicKey: publicKeyBytes,
            } as Ed25519SignedObject
        } else {
            // Plain identity format (just public key hex)
            algorithm = "ed25519"
            publicKeyHex = identity // Use raw value for crypto
            publicKeyForWhitelist = normalizePublicKey(identity) // Normalize for whitelist

            const publicKeyBytes = hexToUint8Array(publicKeyHex)
            const signatureBytes = hexToUint8Array(signature)

            signatureObj = {
                algorithm: algorithm,
                signature: signatureBytes,
                // Message is the full identity string, matching validateIdentityHeaders
                message: new TextEncoder().encode(identity),
                publicKey: publicKeyBytes,
            } as Ed25519SignedObject
        }

        const isValid = await ucrypto.verify(signatureObj)

        if (isValid) {
            log.debug(`[verifySignature] Valid signature for: ${identity}`)
            return {
                valid: true,
                identity,
                publicKey: publicKeyForWhitelist, // Return normalized for whitelist comparison
                algorithm,
            }
        }

        log.debug(`[verifySignature] Invalid signature for: ${identity}`)
        return {
            valid: false,
            identity,
            publicKey: publicKeyForWhitelist,
            algorithm,
            error: "Invalid signature",
        }
    } catch (error) {
        log.error(`[verifySignature] Error verifying signature: ${error}`)
        return {
            valid: false,
            identity,
            publicKey: null,
            algorithm: null,
            error: `Verification error: ${error}`,
        }
    }
}

/**
 * Check if a public key is in the whitelist
 *
 * @param publicKey - The public key to check (hex string)
 * @param whitelistedKeys - Array of whitelisted public keys
 * @returns true if the key is whitelisted
 */
export function isKeyWhitelisted(
    publicKey: string | null,
    whitelistedKeys: string[],
): boolean {
    if (!publicKey || whitelistedKeys.length === 0) {
        return false
    }

    // Normalize: remove any "0x" prefix and convert to lowercase for comparison
    const normalizedKey = publicKey.toLowerCase().replace(/^0x/, "")

    return whitelistedKeys.some(
        key => key.toLowerCase().replace(/^0x/, "") === normalizedKey,
    )
}
