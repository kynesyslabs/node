/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { NodeCall } from "src/libs/network/manageNodeCall"
import { uint8ArrayToHex, hexToUint8Array, Hashing, ucrypto } from "@kynesyslabs/demosdk/encryption"
import crypto from "crypto"
import Peer from "../Peer"

type BufferPayload = {
    type: "Buffer"
    data: number[]
}

type IdentityEnvelope = {
    publicKey?: string
    data?: number[] | string
}

function asHexString(value: string): string | null {
    const trimmed = value.trim()
    const parts = trimmed.includes(":") ? trimmed.split(":", 2) : [null, trimmed]
    const rawWithoutPrefix = parts[1]

    if (!rawWithoutPrefix) {
        return null
    }

    const hasPrefix = rawWithoutPrefix.startsWith("0x") || rawWithoutPrefix.startsWith("0X")
    const candidate = hasPrefix ? rawWithoutPrefix.slice(2) : rawWithoutPrefix

    if (!/^[0-9a-fA-F]+$/.test(candidate)) {
        return null
    }

    return `0x${candidate.toLowerCase()}`
}

function normalizeIdentity(raw: unknown): string | null {
    if (!raw) {
        return null
    }

    if (typeof raw === "string") {
        return asHexString(raw)
    }

    if (raw instanceof Uint8Array) {
        return uint8ArrayToHex(raw).toLowerCase()
    }

    if (ArrayBuffer.isView(raw)) {
        const view = raw as ArrayBufferView
        const bytes =
            view instanceof Uint8Array
                ? view
                : new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
        return uint8ArrayToHex(bytes).toLowerCase()
    }

    if (raw instanceof ArrayBuffer) {
        return uint8ArrayToHex(new Uint8Array(raw)).toLowerCase()
    }

    if (Array.isArray(raw) && raw.every(item => typeof item === "number")) {
        return uint8ArrayToHex(Uint8Array.from(raw)).toLowerCase()
    }

    const maybeBuffer = raw as Partial<BufferPayload>
    if (maybeBuffer?.type === "Buffer" && Array.isArray(maybeBuffer.data)) {
        return uint8ArrayToHex(
            Uint8Array.from(maybeBuffer.data),
        ).toLowerCase()
    }

    const maybeEnvelope = raw as IdentityEnvelope
    if (typeof maybeEnvelope?.publicKey === "string") {
        return asHexString(maybeEnvelope.publicKey)
    }

    if (
        typeof maybeEnvelope?.data === "string" ||
        Array.isArray(maybeEnvelope?.data)
    ) {
        return normalizeIdentity(maybeEnvelope.data)
    }

    return null
}

function normalizeExpectedIdentity(expectedKey: string): string | null {
    if (!expectedKey) {
        return null
    }

    const normalized = asHexString(expectedKey)
    if (normalized) {
        return normalized
    }

    // In some cases keys might arrive already normalized but without the 0x prefix
    if (/^[0-9a-fA-F]+$/.test(expectedKey)) {
        return `0x${expectedKey.toLowerCase()}`
    }

    return null
}

// proxy method
export async function verifyPeer(
    peer: Peer,
    expectedKey: string,
): Promise<Peer> {
    await getPeerIdentity(peer, expectedKey)
    return peer
}

/**
 * Generate a cryptographic challenge for peer authentication
 * @returns Random 32-byte challenge as hex string
 */
function generateChallenge(): string {
    return crypto.randomBytes(32).toString("hex")
}

/**
 * Verify a signed challenge response
 * @param challenge - The original challenge sent to peer
 * @param signature - The signature from peer
 * @param publicKey - The peer's public key
 * @returns true if signature is valid
 */
async function verifyChallenge(
    challenge: string,
    signature: string,
    publicKey: string,
): Promise<boolean> {
    try {
        // Create the expected signed message with domain separation
        const domain = "DEMOS_PEER_AUTH_V1"
        const expectedMessage = `${domain}:${challenge}`
        
        // Normalize public key (remove 0x prefix if present)
        const normalizedPubKey = publicKey.startsWith("0x") 
            ? publicKey.slice(2) 
            : publicKey
        
        // Normalize signature (remove 0x prefix if present)
        const normalizedSignature = signature.startsWith("0x")
            ? signature.slice(2)
            : signature

        // Perform proper ed25519 signature verification
        const isValid = await ucrypto.verify({
            algorithm: "ed25519",
            message: new TextEncoder().encode(expectedMessage),
            publicKey: hexToUint8Array(normalizedPubKey),
            signature: hexToUint8Array(normalizedSignature),
        })

        return isValid
    } catch (error) {
        console.error("[PEER AUTHENTICATION] Challenge verification failed:", error)
        return false
    }
}

// Peer is verified and its status is updated
// Uses cryptographic challenge-response to prevent identity spoofing
export default async function getPeerIdentity(
    peer: Peer,
    expectedKey: string,
): Promise<Peer | null> {
    // Generate cryptographic challenge for this authentication session
    const challenge = generateChallenge()
    
    // Getting our identity
    console.warn("[PEER AUTHENTICATION] Getting peer identity with challenge")
    console.log(peer)
    console.log(expectedKey)

    // Include challenge in the request for cryptographic verification
    const nodeCall: NodeCall = {
        message: "getPeerIdentity",
        data: { challenge }, // Include challenge for signed response
        muid: null,
    }

    const response = await peer.call({
        method: "nodeCall",
        params: [nodeCall],
    })
    console.log(
        "[PEER AUTHENTICATION] Response Received: " +
            JSON.stringify(response, null, 2),
    )
    // Response management
    if (response.result === 200) {
        console.log("[PEER AUTHENTICATION] Received response")
        console.log(response.response)

        // Extract identity and challenge signature from response
        const responseData = response.response
        const receivedIdentity = normalizeIdentity(
            responseData?.identity || responseData?.publicKey || responseData
        )
        const challengeSignature = responseData?.challenge_signature || responseData?.signature
        const expectedIdentity = normalizeExpectedIdentity(expectedKey)

        if (!receivedIdentity) {
            console.log(
                "[PEER AUTHENTICATION] Unable to normalize identity payload",
            )
            return null
        }

        if (!expectedIdentity) {
            console.log(
                "[PEER AUTHENTICATION] Unable to normalize expected identity",
            )
            return null
        }

        // Verify cryptographic challenge-response if signature provided
        // This prevents identity spoofing by requiring proof of private key possession
        if (challengeSignature) {
            const isValidChallenge = await verifyChallenge(
                challenge,
                challengeSignature,
                receivedIdentity,
            )
            if (!isValidChallenge) {
                console.log(
                    "[PEER AUTHENTICATION] Challenge-response verification failed - possible spoofing attempt",
                )
                return null
            }
            console.log("[PEER AUTHENTICATION] Challenge-response verified successfully")
        } else {
            // Log warning but allow connection for backward compatibility
            console.warn(
                "[PEER AUTHENTICATION] WARNING: Peer did not provide challenge signature - " +
                "authentication is weaker without challenge-response verification",
            )
        }

        if (receivedIdentity === expectedIdentity) {
            console.log("[PEER AUTHENTICATION] Identity is the expected one")
        } else {
            console.log(
                "[PEER AUTHENTICATION] Identity is not the expected one",
            )
            console.log("Expected: ")
            console.log(expectedIdentity)
            console.log("Received: ")
            console.log(receivedIdentity)
            return null
        }
        // Adding the property to the peer
        peer.identity = receivedIdentity // Identity is now known
        peer.status.online = true // Peer is now online
        peer.status.ready = true // Peer is now ready
        peer.status.timestamp = new Date().getTime()
        peer.verification.status = true // We verified the peer
        peer.verification.message = `getPeerIdentity routine verified with challenge-response (challenge: ${challenge.slice(0, 16)}...)`
        peer.verification.timestamp = new Date().getTime()
    } else {
        console.log(
            "[PEER AUTHENTICATION] [FAILED] Response " +
                response.result +
                " received: " +
                response.response,
        )
        return null
    }
    // ? Should we add it to the peerList here instead of in the peerBootstrap routine / hello_peer routine?
    return peer
}
