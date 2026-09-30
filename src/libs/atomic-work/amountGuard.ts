/**
 * WHY (AW-19): under the osDenomination fork, amounts are OS-decimal-integer
 * strings. If a hashed Atomic Work payload carried a JS number instead, the
 * canonical bytes — and thus workId/conflictDigest — would diverge across the
 * fork boundary (the fork already broke content-hash alignment once). Reject
 * anything that is not a bare decimal-integer string before hashing.
 */
export function assertOsCanonicalAmount(
    amount: unknown,
    field: string,
): asserts amount is string {
    if (typeof amount !== "string" || !/^[0-9]+$/.test(amount)) {
        throw new Error(
            `Atomic Work: ${field} must be an OS-decimal-integer string, got ${
                typeof amount === "string" ? JSON.stringify(amount) : typeof amount
            }`,
        )
    }
}
