/**
 * What an XM log may say about an error: its class and, when it is a short
 * [A-Z0-9_] token, its code (for example `Error CALL_EXCEPTION`). Messages,
 * short messages and revert reasons can quote the signed transaction or the
 * call arguments, so the full error goes to the caller only.
 */
export default function errorKind(error: unknown): string {
    if (error === null || typeof error !== "object") return typeof error
    // NOTE The class comes from the prototype, which a remote party cannot set
    const name = Object.getPrototypeOf(error)?.constructor?.name
    const kind = typeof name === "string" && /^\w{1,64}$/.test(name) ? name : "object"
    const { code } = error as { code?: unknown }
    return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code)
        ? `${kind} ${code}`
        : kind
}

/**
 * A caller-supplied field as one log value: a string is JSON-escaped, with
 * DEL, C1 controls and U+2028/U+2029 also escaped as a 4-digit hex escape,
 * and cut to 64 characters inside its quotes. Anything else is logged as its
 * type.
 */
export function logField(value: unknown): string {
    if (typeof value !== "string") return typeof value
    let escaped = ""
    for (const char of value) {
        const code = char.charCodeAt(0)
        // NOTE JSON.stringify leaves DEL, C1 and U+2028/U+2029 as they are
        const next =
            (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029
                ? `\\u${code.toString(16).padStart(4, "0")}`
                : JSON.stringify(char).slice(1, -1)
        if (escaped.length + next.length > 64) break
        escaped += next
    }
    return `"${escaped}"`
}

/**
 * A caller-supplied collection as its entry count, its first 10 entries as
 * `describe` gives them and a count of the rest. Only an object or an array
 * is enumerated (a string would give one entry per character), anything else
 * counts as empty. The legacy `log` wrapper has no level check, so the line is
 * bounded instead: only the first 10 entries are described.
 */
export function logEntries(
    collection: unknown,
    noun: string,
    describe: (entry: any) => string,
): string {
    // NOTE An array is used as is: Object.values would copy every entry
    const entries = Array.isArray(collection)
        ? collection
        : collection && typeof collection === "object"
          ? Object.values(collection)
          : []
    const listed = entries.slice(0, 10).map(describe)
    if (entries.length > 10) listed.push(`${entries.length - 10} more`)
    return `${entries.length} ${noun}: ${listed.join(", ")}`
}
