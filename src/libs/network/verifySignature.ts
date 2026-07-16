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

        if (splits.length > 1 && SUPPORTED_ALGORITHMS.includes(splits[0])) {
            // Format: "algorithm:publicKeyHex"
            algorithm = splits[0]
            publicKeyHex = splits[1] // Use raw value for crypto

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
                publicKey: publicKeyHex,
                algorithm,
            }
        }

        log.debug(`[verifySignature] Invalid signature for: ${identity}`)
        return {
            valid: false,
            identity,
            publicKey: publicKeyHex,
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
 * Verify a signature over an explicit, caller-supplied message.
 *
 * Unlike {@link verifySignature} (whose signed message is fixed to the
 * identity / public-key form), this verifies a signature over an arbitrary
 * canonical message. Used for replay-resistant request authentication where
 * the message binds the signer to a specific request.
 *
 * `identity` must be in "algorithm:publicKeyHex" form. The recovered public
 * key (raw hex, no prefix) is returned so callers can match it against stored
 * addresses (which use the same raw public-key form as `tx.content.from`).
 *
 * @param identity - Signer identity, "algorithm:publicKeyHex"
 * @param signature - Hex-encoded signature over `message`
 * @param message - The exact canonical message that was signed
 */
export async function verifySignatureOverMessage(
    identity: string,
    signature: string,
    message: string,
): Promise<VerificationResult> {
    if (!identity || !signature || !message) {
        return {
            valid: false,
            identity: identity || null,
            publicKey: null,
            algorithm: null,
            error: "Missing identity, signature, or message",
        }
    }

    const splits = identity.split(":")
    if (splits.length < 2 || !SUPPORTED_ALGORITHMS.includes(splits[0])) {
        return {
            valid: false,
            identity,
            publicKey: null,
            algorithm: null,
            error: "Unsupported or malformed identity",
        }
    }

    const algorithm = splits[0]
    const publicKeyHex = splits[1]

    try {
        const signatureObj = {
            algorithm,
            signature: hexToUint8Array(signature),
            message: new TextEncoder().encode(message),
            publicKey: hexToUint8Array(publicKeyHex),
        } as Ed25519SignedObject

        const isValid = await ucrypto.verify(signatureObj)
        if (isValid) {
            return { valid: true, identity, publicKey: publicKeyHex, algorithm }
        }

        return {
            valid: false,
            identity,
            publicKey: publicKeyHex,
            algorithm,
            error: "Invalid signature",
        }
    } catch (error) {
        log.error(
            `[verifySignatureOverMessage] Error verifying signature: ${error}`,
        )
        return {
            valid: false,
            identity,
            publicKey: null,
            algorithm,
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
