/**
 * Postgres cannot hold U+0000 in a `text`/`varchar` column or anywhere in a
 * `jsonb` value, keys included. A value carrying one passes every check a
 * validator runs and then fails the block's database transaction on every
 * node, so it has to be refused while it is still a transaction.
 */

export const NUL_CHARACTER_REFUSAL =
    "cannot contain U+0000, which Postgres cannot store"

/**
 * Whether a JSON-shaped value holds U+0000 in any string or key. Walked
 * without recursion: the value comes from a transaction and may be nested
 * deeper than the call stack.
 */
export function containsNulCharacter(value: unknown): boolean {
    const pending: unknown[] = [value]
    while (pending.length > 0) {
        const item = pending.pop()
        if (typeof item === "string") {
            if (item.includes("\u0000")) return true
            continue
        }
        if (typeof item !== "object" || item === null) continue
        if (Array.isArray(item)) {
            for (const element of item) pending.push(element)
            continue
        }
        for (const [key, element] of Object.entries(item)) {
            if (key.includes("\u0000")) return true
            pending.push(element)
        }
    }
    return false
}
