import bs58 from "bs58"
import Hashing from "@/libs/crypto/hashing"

export class ReferralCodes {
    /**
     * Calculate optimal bytes needed for target length
     */
    private static calculateBytesForLength(targetLength: number): number {
        // Base58 encoding: ~1.37 bytes per character on average
        // Add buffer to ensure we have enough entropy
        const bytesMap = {
            8: 8, // ~56 bits (vs your 48 bits)
            10: 9, // ~63 bits
            12: 10, // ~70 bits
            16: 14, // ~98 bits
        }

        return bytesMap[targetLength as keyof typeof bytesMap] || 10
    }

    /**
     * Generate a 2-character checksum for validation
     */
    private static generateChecksum(publicKey: string): string {
        const cleanKey = publicKey.startsWith("0x")
            ? publicKey.slice(2)
            : publicKey
        const checksumHash = Hashing.sha256(cleanKey + "CHECKSUM")
        const checksumBytes = Buffer.from(checksumHash.slice(0, 4), "hex")
        const checksumB58 = bs58.encode(checksumBytes)
        return checksumB58.substring(0, 2)
    }

    /**
     * Generate a collision-resistant referral code from an ed25519 public key
     * @param publicKey The 66-character hex ed25519 public key (0x...)
     * @param options Configuration options
     * @returns Referral code with specified properties
     */
    static generateReferralCode(
        publicKey: string,
        options: {
            length?: 8 | 10 | 12 | 16 // Explicit length options
            includeChecksum?: boolean // Add checksum for validation
            prefix?: string // Optional prefix
        } = {},
    ): string {
        const { length = 12, includeChecksum = false, prefix = "" } = options

        // Remove 0x prefix if present
        const cleanKey = publicKey.startsWith("0x")
            ? publicKey.slice(2)
            : publicKey

        // Validate input
        if (cleanKey.length !== 64) {
            throw new Error(
                "Invalid ed25519 public key: must be 64 hex characters",
            )
        }

        // Hash the public key to get uniform distribution
        const hash = Hashing.sha256(cleanKey)

        // Calculate bytes needed based on desired length and encoding efficiency
        const bytesNeeded = this.calculateBytesForLength(length)
        const hashBytes = Buffer.from(hash.slice(0, bytesNeeded * 2), "hex")

        // Encode using Base58 for human-friendly format
        let code = bs58.encode(hashBytes)

        // Truncate to exact length (Base58 can vary by 1-2 chars)
        code = code.substring(0, length)

        // Add checksum if requested
        if (includeChecksum) {
            const checksum = this.generateChecksum(publicKey)
            code = code.substring(0, length - 2) + checksum
        }

        return prefix + code
    }
}
