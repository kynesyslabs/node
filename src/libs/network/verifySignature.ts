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
import { audienceKey, httpAuthMessage } from "./peerHttpAuth"
import { SeenAuthMessages } from "./authReplayCache"
import { getSharedState } from "src/utilities/sharedState"

/**
 * Max age of a timestamp-bound auth header (audit C3b). A captured header is
 * only replayable within this window, not forever.
 */
const AUTH_TIMESTAMP_MAX_AGE_MS = 5 * 60 * 1000

/**
 * Body-bound requests accepted within the timestamp window; a repeat is a
 * replay. Sized well above what honest peers send in one window.
 */
export const seenAuthMessages = new SeenAuthMessages(200_000)

/**
 * The replay cache lives in memory, so it starts empty: a request signed
 * before this process started could be replayed once. Body-bound requests
 * signed before then are refused; the slack covers a peer clock a little
 * behind ours.
 */
const PROCESS_START_MS = Date.now()
export const RESTART_CLOCK_SLACK_MS = 2_000

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

    /** Whether the signature names this node as the request's audience. */
    audienceBound?: boolean

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
    audience?: string | null,
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

    // An audience is part of the body-bound form only, and must be us.
    const audienceBound = typeof audience === "string"
    if (audienceBound) {
        const ours = getSharedState.publicKeyHex
        if (!bodyBound || !ours || audienceKey(audience) !== audienceKey(ours)) {
            return {
                valid: false,
                identity,
                publicKey: null,
                algorithm: null,
                error: bodyBound ? "Request is for another node" : "Audience needs a body-bound signature",
            }
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
        const timestampError =
            checkAuthTimestamp(timestamp) ??
            (bodyBound && Number(timestamp) < PROCESS_START_MS - RESTART_CLOCK_SLACK_MS
                ? "Auth timestamp predates this node's start"
                : null)
        if (timestampError) {
            return {
                valid: false,
                identity,
                publicKey: null,
                algorithm: null,
                error: timestampError,
            }
        }
    }

    try {
        const splits = identity.split(":")
        // "algorithm:publicKeyHex" signs the bare key hex in legacy form;
        // the plain format (just the key hex) signs the whole identity.
        const prefixed =
            splits.length > 1 && SUPPORTED_ALGORITHMS.includes(splits[0])
        const algorithm = prefixed ? splits[0] : "ed25519"
        // The raw hex for crypto operations (no normalization)
        const publicKeyHex = prefixed ? splits[1] : identity

        // Body-bound form signs identity, timestamp and body hash; the
        // timestamp form signs sha256(`${identity}:${timestamp}`); legacy
        // form signs the bare publicKey hex or plain identity.
        let authMessage = publicKeyHex
        if (bodyBound) {
            authMessage = httpAuthMessage(
                genesisHash!,
                identity,
                timestamp!,
                bodyHash!,
                audienceBound ? audienceKey(audience) : undefined,
            )
        } else if (requireTimestampBinding) {
            authMessage = Hashing.sha256(`${identity}:${timestamp}`)
        }

        const signatureObj: signedObject = {
            algorithm: algorithm,
            signature: hexToUint8Array(signature),
            message: new TextEncoder().encode(authMessage),
            publicKey: hexToUint8Array(publicKeyHex),
        } as Ed25519SignedObject

        const isValid = await TxValidatorPool.getInstance().verify(signatureObj)

        if (
            isValid &&
            bodyBound &&
            !seenAuthMessages.claim(
                authMessage,
                Number(timestamp) + AUTH_TIMESTAMP_MAX_AGE_MS,
            )
        ) {
            log.debug(`[verifySignature] Replayed request from: ${identity}`)
            return {
                valid: false,
                identity,
                publicKey: publicKeyHex,
                algorithm,
                error: "Replayed request",
            }
        }

        if (isValid) {
            return {
                valid: true,
                identity,
                publicKey: publicKeyHex,
                algorithm,
                bodyHash: bodyBound ? bodyHash : null,
                audienceBound,
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

/** Why a timestamp-bound auth header's timestamp is refused, or null if fresh. */
function checkAuthTimestamp(timestamp?: string | null): string | null {
    if (!timestamp) {
        return "Missing timestamp header — update your SDK (auth now requires a timestamp-bound signature)"
    }
    const ts = Number(timestamp)
    if (!Number.isFinite(ts)) {
        return "Malformed timestamp header"
    }
    if (Math.abs(Date.now() - ts) > AUTH_TIMESTAMP_MAX_AGE_MS) {
        return "Auth timestamp outside acceptable window"
    }
    return null
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
