/**
 * JCS (RFC 8785) canonical JSON + CF-1 NFC normalization.
 *
 * WHY: Atomic Work `workId`/`conflictDigest` must be byte-identical to the DACS
 * reference, which hashes JCS-canonical bytes with NFC-normalized strings and
 * keys. The SDK `canonicalJSONStringify` sorts keys but does NOT NFC-normalize,
 * so it can't be reused verbatim for cross-implementation byte equality.
 *
 * Keys are sorted by UTF-16 code units — JS default string sort already does this.
 */
export function jcsCanonicalize(value: unknown): string {
    return serialize(value, new Set())
}

function serialize(value: unknown, seen: Set<object>): string {
    if (value === null) return "null"
    const t = typeof value
    if (t === "string") return JSON.stringify((value as string).normalize("NFC"))
    if (t === "boolean") return value ? "true" : "false"
    if (t === "number") {
        if (!Number.isFinite(value)) throw new Error("JCS: non-finite number")
        return JSON.stringify(value)
    }
    if (t === "bigint" || t === "undefined" || t === "function" || t === "symbol")
        throw new Error(`JCS: non-JSON value: ${t}`)

    const obj = value as object
    if (seen.has(obj)) throw new Error("JCS: circular reference")
    seen.add(obj)

    let out: string
    if (Array.isArray(obj)) {
        out = `[${obj.map(v => serialize(v, seen)).join(",")}]`
    } else {
        const proto = Object.getPrototypeOf(obj)
        if (proto !== Object.prototype && proto !== null)
            throw new Error(
                `JCS: only plain objects supported (found ${proto?.constructor?.name})`,
            )
        const rec = obj as Record<string, unknown>
        // NFC-normalize keys for output + sort, but look up values by the
        // ORIGINAL key — normalization can change the string. Strict: undefined
        // values are NOT dropped; they fall through to the non-JSON throw.
        const entries = Object.keys(rec).map(
            k => [k.normalize("NFC"), k] as const,
        )
        entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        const parts = entries.map(
            ([nk, ok]) => `${JSON.stringify(nk)}:${serialize(rec[ok], seen)}`,
        )
        out = `{${parts.join(",")}}`
    }
    seen.delete(obj)
    return out
}
