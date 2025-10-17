import { SignatureType } from "@kynesyslabs/demosdk/types"

/**
 * SignatureDetector - Utility for detecting signature types from address formats
 *
 * Supports:
 * - EVM addresses (secp256k1): 0x-prefixed 40 hex characters
 * - Solana addresses (ed25519): Base58-encoded 32-44 characters
 *
 * Pattern matching approach avoids unnecessary crypto library imports
 */

/**
 * Detect signature type from address format
 *
 * @param address - The blockchain address to analyze
 * @returns SignatureType ("evm" | "solana") or null if unrecognized
 *
 * @example
 * detectSignatureType("0x45238D633D6a1d18ccde5fFD234958ECeA46eB86") // "evm"
 * detectSignatureType("8VqZ8cqQ8h9FqF7cXNx5bXKqNz9V8F7h9FqF7cXNx5b") // "solana"
 */
export function detectSignatureType(address: string): SignatureType | null {
    // EVM address pattern: 0x followed by 40 hex characters
    // Examples: 0x45238D633D6a1d18ccde5fFD234958ECeA46eB86
    if (/^0x[0-9a-fA-F]{40}$/.test(address)) {
        return "evm"
    }

    // Solana address pattern: Base58 encoded, typically 32-44 characters
    // Base58 alphabet: 123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz
    // Examples: 8VqZ8cqQ8h9FqF7cXNx5bXKqNz9V8F7h9FqF7cXNx5b
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
        return "solana"
    }

    // Unrecognized format
    return null
}

/**
 * Validate that an address matches the expected signature type
 *
 * @param address - The blockchain address to validate
 * @param expectedType - The expected signature type
 * @returns true if address matches expected type
 *
 * @example
 * validateAddressType("0x1234...", "evm") // true
 * validateAddressType("0x1234...", "solana") // false
 */
export function validateAddressType(
    address: string,
    expectedType: SignatureType,
): boolean {
    const detectedType = detectSignatureType(address)
    return detectedType === expectedType
}

/**
 * Check if an address is signable (recognized format)
 *
 * @param address - The blockchain address to check
 * @returns true if address is in a recognized signable format
 */
export function isSignableAddress(address: string): boolean {
    return detectSignatureType(address) !== null
}
