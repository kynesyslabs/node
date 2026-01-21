import { Buffer } from "buffer"

const DEFAULT_PUBLIC_KEY = new Uint8Array(32).fill(1)
const DEFAULT_SIGNATURE = new Uint8Array([1, 2, 3, 4])

export const ucrypto = {
    async getIdentity(
        algorithm: string,
    ): Promise<{ publicKey: Uint8Array; algorithm: string }> {
        return {
            publicKey: DEFAULT_PUBLIC_KEY,
            algorithm,
        }
    },

    async sign(
        algorithm: string,
        message: Uint8Array | ArrayBuffer,
    ): Promise<{ signature: Uint8Array }> {
        void algorithm
        void message
        return { signature: DEFAULT_SIGNATURE }
    },

    async verify(): Promise<boolean> {
        return true
    },
}

export function uint8ArrayToHex(input: Uint8Array): string {
    return Buffer.from(input).toString("hex")
}

export function hexToUint8Array(hex: string): Uint8Array {
    const normalized = hex.startsWith("0x") ? hex.slice(2) : hex
    return new Uint8Array(Buffer.from(normalized, "hex"))
}
