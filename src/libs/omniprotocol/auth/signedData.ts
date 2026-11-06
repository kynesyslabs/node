import { keccak_256 } from "@noble/hashes/sha3.js"

/** Separates these signatures from anything else the node key signs. */
const OMNI_AUTH_DOMAIN = Buffer.from("DEMOS_OMNI_AUTH_V2", "utf8")

/**
 * Bytes signed under SIGN_TIMESTAMPED_PAYLOAD_HASH, shared by the sender and
 * the verifier so the two cannot drift apart. The genesis hash names the
 * network, so a frame captured on one network does not verify on another.
 */
export function timestampedSignedData(
    genesisHash: string,
    opcode: number,
    sequence: number,
    timestamp: number,
    payload: Buffer,
): Buffer {
    const fixed = Buffer.allocUnsafe(1 + 4 + 8)
    fixed.writeUInt8(opcode, 0)
    fixed.writeUInt32BE(sequence, 1)
    fixed.writeBigUInt64BE(BigInt(timestamp), 5)
    const genesis = Buffer.from(genesisHash, "utf8")
    const genesisLen = Buffer.allocUnsafe(2)
    genesisLen.writeUInt16BE(genesis.length)
    return Buffer.concat([
        OMNI_AUTH_DOMAIN,
        genesisLen,
        genesis,
        fixed,
        Buffer.from(keccak_256(payload)),
    ])
}
