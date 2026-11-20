/**
 * Whole amounts in a genesis file (balances, stakes) are read as decimal
 * digits only. BigInt() alone also takes "" (as 0), surrounding spaces,
 * "+5" and hex or binary prefixes ("0x10" is 16), so a typo or a value
 * copied from another tool would be credited silently instead of refused.
 */

const SIGNED_DECIMAL = /^-?[0-9]+$/

/**
 * The amount as a bigint, or null when it is not written in decimal digits.
 * A leading minus is read, so callers keep their own sign check and message.
 * Numbers must be safe integers: a larger one has already lost digits.
 */
export function decimalBigInt(raw: unknown): bigint | null {
    if (typeof raw === "string") return SIGNED_DECIMAL.test(raw) ? BigInt(raw) : null
    if (typeof raw === "number") return Number.isSafeInteger(raw) ? BigInt(raw) : null
    if (typeof raw === "bigint") return raw
    return null
}
