import crypto from "node:crypto"

/**
 * Ed25519 over raw bytes. The signed message is ASCII, and the account key is
 * the raw 32-byte public key, so the SPKI wrapping below is the whole
 * conversion; node:crypto keeps two hundred checks per block cheap on the
 * thread that applies the block.
 */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex")

export function verifyEd25519(message: Uint8Array, signatureHex: string, account: string): boolean {
    try {
        const key = crypto.createPublicKey({
            key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(account.slice(2), "hex")]),
            format: "der",
            type: "spki",
        })
        return crypto.verify(null, Buffer.from(message), key, Buffer.from(signatureHex.slice(2), "hex"))
    } catch {
        return false
    }
}
