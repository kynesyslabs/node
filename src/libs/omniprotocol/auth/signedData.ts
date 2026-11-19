import { keccak_256 } from "@noble/hashes/sha3.js"

/** Separates these signatures from anything else the node key signs. */
const OMNI_AUTH_DOMAIN = Buffer.from("DEMOS_OMNI_AUTH_V3", "utf8")

function lengthPrefixed(text: string): Buffer {
    const bytes = Buffer.from(text, "utf8")
    const len = Buffer.allocUnsafe(2)
    len.writeUInt16BE(bytes.length)
    return Buffer.concat([len, bytes])
}

/** A node identity as the recipient field signs it: lowercase hex, no 0x. */
export function recipientField(identity: string): string {
    return identity.toLowerCase().replace(/^0x/, "")
}

/**
 * Bytes signed under SIGN_TIMESTAMPED_PAYLOAD_HASH, shared by the sender and
 * the verifier so the two cannot drift apart. The genesis hash names the
 * network, so a frame captured on one network does not verify on another.
 * The recipient names the node the frame was sent to, so a node that
 * receives it cannot replay it to another node as the sender (which would
 * prove the sender's identity, a validator's included, on its own socket).
 */
export function timestampedSignedData(
    genesisHash: string,
    recipient: string,
    opcode: number,
    sequence: number,
    timestamp: number,
    payload: Buffer,
): Buffer {
    const fixed = Buffer.allocUnsafe(1 + 4 + 8)
    fixed.writeUInt8(opcode, 0)
    fixed.writeUInt32BE(sequence, 1)
    fixed.writeBigUInt64BE(BigInt(timestamp), 5)
    return Buffer.concat([
        OMNI_AUTH_DOMAIN,
        lengthPrefixed(genesisHash),
        lengthPrefixed(recipientField(recipient)),
        fixed,
        Buffer.from(keccak_256(payload)),
    ])
}
