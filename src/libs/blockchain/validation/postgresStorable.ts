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
        if (ArrayBuffer.isView(item)) continue
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

/**
 * A transaction is refused whole: its body is stored as `json` (which keeps
 * U+0000) but `to`, `from`, `type`, the hash and the signature are copied into
 * `varchar` columns and the edits it implies into `jsonb` rows, so a NUL
 * anywhere in it can end up in a column that refuses it.
 */
export function transactionNulRefusal(tx: unknown): string | null {
    return containsNulCharacter(tx) ? `Transaction ${NUL_CHARACTER_REFUSAL}` : null
}

const ESCAPED_NUL = /(?<!\\)((?:\\\\)*)\\u0000/g

/**
 * The value with every U+0000 in its strings and keys replaced by U+FFFD, for
 * node-written metadata (`attrs`) that may quote transaction input. The
 * metadata is not covered by any hash, so rewriting it changes nothing a peer
 * checks. A value with no NUL is returned as is.
 */
export function withoutNulCharacters<T>(value: T): T {
    if (!containsNulCharacter(value)) return value
    return JSON.parse(
        JSON.stringify(value).replace(ESCAPED_NUL, "$1\\ufffd"),
    ) as T
}
