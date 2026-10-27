/**
 * Score identities (Nomis, Ethos) carry a provider score that decides the
 * points an account is awarded. Block application runs on every validator and
 * on every node that replays old blocks, so it cannot ask the provider: the
 * answer differs between nodes and over time, and nodes would reach different
 * state from the same block. The provider is asked once, when a node first
 * accepts the transaction, and the transaction is refused unless the values
 * the client signed are the ones the provider reports. Apply then writes the
 * signed values as they are.
 */

/**
 * Nomis reports its score as a fraction in [0, 1]. A client that parses and
 * re-serialises that number may round its last binary digits; anything larger
 * than this is a different score, not a formatting difference.
 */
export const NON_INTEGER_SCORE_TOLERANCE = 1e-9

/**
 * Whether a signed number equals the provider's. Integer provider values
 * (Ethos scores and ids, Nomis model ids) must match exactly; non-integer ones
 * within NON_INTEGER_SCORE_TOLERANCE.
 */
export function sameProviderNumber(claimed: unknown, fetched: unknown): boolean {
    if (typeof claimed !== "number" || typeof fetched !== "number") return false
    if (!Number.isFinite(claimed) || !Number.isFinite(fetched)) return false
    if (Number.isInteger(fetched)) return claimed === fetched
    return Math.abs(claimed - fetched) <= NON_INTEGER_SCORE_TOLERANCE
}

/** Like sameProviderNumber, with an absent value on both sides as a match. */
export function sameOptionalProviderNumber(
    claimed: unknown,
    fetched: unknown,
): boolean {
    const c = claimed ?? null
    const f = fetched ?? null
    if (c === null || f === null) return c === f
    return sameProviderNumber(c, f)
}

/** Exact string match, with an absent value on both sides as a match. */
export function sameOptionalString(claimed: unknown, fetched: unknown): boolean {
    return (claimed ?? null) === (fetched ?? null)
}

export function isParsableTimestamp(value: unknown): value is string {
    return typeof value === "string" && Number.isFinite(Date.parse(value))
}
