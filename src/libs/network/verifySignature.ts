/**
 * Signature Verification Utility
 *
 * Shared signature verification logic for both rate limiter middleware
 * and RPC route handlers. Supports ed25519, falcon, and ml-dsa algorithms.
 */

import { ucrypto, hexToUint8Array } from "@kynesyslabs/demosdk/encryption"
import { Ed25519SignedObject, signedObject } from "@kynesyslabs/demosdk/types"
import log from "src/utilities/logger"
import Hashing from "src/libs/crypto/hashing"
import TxValidatorPool from "../blockchain/validation/txValidatorPool"
import { httpAuthMessage } from "./peerHttpAuth"
import { getSharedState } from "src/utilities/sharedState"

/**
 * Max age of a timestamp-bound auth header (audit C3b). A captured header is
 * only replayable within this window, not forever.
 */
const AUTH_TIMESTAMP_MAX_AGE_MS = 5 * 60 * 1000

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
     * The body hash the signature covers, when the caller used the
     * body-bound form; the body itself still has to be checked against it.
     */
    bodyHash?: string | null

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
    timestamp?: string | null,
    requireTimestampBinding = false,
    bodyHash?: string | null,
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

    // The body-bound form is only sent by upgraded nodes, so its timestamp
    // is checked whatever the fork state.
    const bodyBound = typeof bodyHash === "string"
    if (bodyBound && !/^[0-9a-f]{64}$/.test(bodyHash)) {
        return {
            valid: false,
            identity,
            publicKey: null,
            algorithm: null,
            error: "Malformed body-hash header",
        }
    }

    // The body-bound form names our network; until it is known no such
    // request can be checked, so peer methods are not served yet.
    const genesisHash = getSharedState.genesisBlockHash
    if (bodyBound && !genesisHash) {
        return {
            valid: false,
            identity,
            publicKey: null,
            algorithm: null,
            error: "Genesis hash not known yet",
        }
    }

    // AUDIT C3b — when timestamp-binding is required (nonceEnforcement fork
    // active), the auth signature must cover `${identity}:${timestamp}` with a
    // fresh timestamp, so a captured header is not a static replayable bearer
    // token. A legacy client that signs the bare public key (no/empty
    // timestamp) is rejected with a clear upgrade message.
    if (requireTimestampBinding || bodyBound) {
        if (!timestamp) {
            return {
                valid: false,
                identity,
                publicKey: null,
                algorithm: null,
                error: "Missing timestamp header — update your SDK (auth now requires a timestamp-bound signature)",
            }
        }
        const ts = Number(timestamp)
        if (!Number.isFinite(ts)) {
            return {
                valid: false,
                identity,
                publicKey: null,
                algorithm: null,
                error: "Malformed timestamp header",
            }
        }
        if (Math.abs(Date.now() - ts) > AUTH_TIMESTAMP_MAX_AGE_MS) {
            return {
                valid: false,
                identity,
                publicKey: null,
                algorithm: null,
                error: "Auth timestamp outside acceptable window",
            }
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

            // Body-bound form signs identity, timestamp and body hash; the
            // timestamp form signs sha256(`${identity}:${timestamp}`); legacy
            // form signs the bare publicKey hex (splits[1]).
            const authMessage = bodyBound
                ? httpAuthMessage(genesisHash!, identity, timestamp!, bodyHash!)
                : requireTimestampBinding
                  ? Hashing.sha256(`${identity}:${timestamp}`)
                  : publicKeyHex

            signatureObj = {
                algorithm: algorithm,
                signature: signatureBytes,
                message: new TextEncoder().encode(authMessage),
                publicKey: publicKeyBytes,
            } as Ed25519SignedObject
        } else {
            // Plain identity format (just public key hex)
            algorithm = "ed25519"
            publicKeyHex = identity // Use raw value for crypto

            const publicKeyBytes = hexToUint8Array(publicKeyHex)
            const signatureBytes = hexToUint8Array(signature)

            const authMessage = bodyBound
                ? httpAuthMessage(genesisHash!, identity, timestamp!, bodyHash!)
                : requireTimestampBinding
                  ? Hashing.sha256(`${identity}:${timestamp}`)
                  : identity

            signatureObj = {
                algorithm: algorithm,
                signature: signatureBytes,
                message: new TextEncoder().encode(authMessage),
                publicKey: publicKeyBytes,
            } as Ed25519SignedObject
        }

        const isValid = await TxValidatorPool.getInstance().verify(signatureObj)

        if (isValid) {
            return {
                valid: true,
                identity,
                publicKey: publicKeyHex,
                algorithm,
                bodyHash: bodyBound ? bodyHash : null,
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
