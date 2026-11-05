/**
 * Hex as finality proofs spell it: lowercase, no `0x`. Parsing is strict so
 * one hash has exactly one accepted spelling on the wire.
 */

const HEX = /^(?:[0-9a-f]{2})*$/

export function toHex(bytes: Uint8Array): string {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex")
}

export function fromHex(hex: string): Uint8Array {
    if (typeof hex !== "string" || !HEX.test(hex)) {
        throw new Error("merkle: expected lowercase hex without 0x")
    }
    return new Uint8Array(Buffer.from(hex, "hex"))
}

/** A 32-byte hash given as bytes or as lowercase hex. */
export type HashInput = Uint8Array | string

export function hash32(input: HashInput, what: string): Uint8Array {
    const bytes = typeof input === "string" ? fromHex(input) : input
    if (!(bytes instanceof Uint8Array) || bytes.length !== 32) {
        throw new Error(`merkle: ${what} must be 32 bytes`)
    }
    return bytes
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false
    let diff = 0
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
    return diff === 0
}
