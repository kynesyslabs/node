/**
 * L2PS Messaging Crypto Helpers
 *
 * Provides E2E encryption for messages using the SDK's UnifiedCrypto.
 * Uses ML-KEM-AES (post-quantum) for message encryption and ed25519 for signing.
 *
 * These helpers are intended for use by both the node (for offline message
 * re-encryption) and as a reference for SDK client implementations.
 */

import { Hashing } from "@kynesyslabs/demosdk/encryption"
import type { SerializedEncryptedMessage } from "./types"

/**
 * Compute a deterministic message hash for dedup and integrity.
 *
 * Hash input is canonical JSON of the field bag rather than a
 * `from:to:content:ts` concatenation. The bare-string form was
 * delimiter-ambiguous: a `from` of `"a:b"` would collide with a
 * different `to` value, silently weakening the unique-row invariant on
 * `l2ps_messages.message_hash`. Field names + JSON quoting keep every
 * tuple distinct.
 */
export function computeMessageHash(
    from: string,
    to: string,
    content: string,
    timestamp: number,
): string {
    const input = JSON.stringify({ from, to, content, timestamp })
    return Hashing.sha256(input)
}

/**
 * Encrypt a plaintext message using AES-256-GCM with a random key.
 * This is a symmetric helper for local encryption — for E2E encryption
 * between peers, use UnifiedCrypto.encrypt("ml-kem-aes", data, peerPublicKey)
 * on the client side.
 *
 * Returns a SerializedEncryptedMessage suitable for wire transport.
 */
export async function encryptMessage(
    plaintext: string,
    sharedKey: Uint8Array,
): Promise<SerializedEncryptedMessage> {
    const nonce = crypto.getRandomValues(new Uint8Array(12))
    const encoded = new TextEncoder().encode(plaintext)

    const cryptoKey = await crypto.subtle.importKey(
        "raw", sharedKey.buffer as ArrayBuffer, "AES-GCM", false, ["encrypt"],
    )

    const cipherBuffer = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce } as AesGcmParams,
        cryptoKey,
        encoded,
    )

    return {
        ciphertext: Buffer.from(cipherBuffer).toString("base64"),
        nonce: Buffer.from(nonce).toString("base64"),
    }
}

/**
 * Decrypt a SerializedEncryptedMessage using AES-256-GCM.
 */
export async function decryptMessage(
    encrypted: SerializedEncryptedMessage,
    sharedKey: Uint8Array,
): Promise<string> {
    const cipherBuffer = Buffer.from(encrypted.ciphertext, "base64")
    const nonce = Buffer.from(encrypted.nonce, "base64")

    const cryptoKey = await crypto.subtle.importKey(
        "raw", sharedKey.buffer as ArrayBuffer, "AES-GCM", false, ["decrypt"],
    )

    const plainBuffer = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce } as AesGcmParams,
        cryptoKey,
        cipherBuffer,
    )

    return new TextDecoder().decode(plainBuffer)
}

/**
 * Generate a random AES-256 key for symmetric encryption.
 */
export function generateSymmetricKey(): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(32))
}
