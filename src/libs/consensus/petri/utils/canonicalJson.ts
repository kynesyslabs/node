/**
 * Deterministic JSON serialization for Petri Consensus delta hashing.
 *
 * Critical property: identical objects MUST produce identical strings
 * regardless of key insertion order, Map iteration order, or BigInt representation.
 *
 * Used to hash state deltas so all shard members agree on the same hash
 * for the same logical state change.
 */

/**
 * Serialize a value to a canonical JSON string with sorted keys.
 * Handles: objects (sorted keys), arrays, BigInt (string with 'n' suffix),
 * Maps (sorted entries), Sets (sorted values), primitives.
 */
export function canonicalJson(value: unknown): string {
    return JSON.stringify(value, replacer, 0)
}

function replacer(_key: string, value: unknown): unknown {
    if (typeof value === "bigint") {
        return value.toString() + "n"
    }

    if (value instanceof Map) {
        const sorted = Array.from(value.entries()).sort((a, b) =>
            String(a[0]).localeCompare(String(b[0])),
        )
        return Object.fromEntries(sorted)
    }

    if (value instanceof Set) {
        return Array.from(value).sort()
    }

    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        const sorted: Record<string, unknown> = {}
        for (const k of Object.keys(value as Record<string, unknown>).sort()) {
            sorted[k] = (value as Record<string, unknown>)[k]
        }
        return sorted
    }

    return value
}
