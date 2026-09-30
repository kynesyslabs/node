/**
 * JCS (RFC 8785) canonical JSON with CF-1 normalization.
 *
 * Work identity, authorization hashes and receipt commitments all hash these
 * bytes, so any divergence from the reference is a divergence in consensus
 * identity — the same payload would be a different Work here than there.
 *
 * Two rules carry that weight and are easy to get backwards:
 *
 * Normalization is asymmetric. String *values* are NFC-normalized; object
 * *keys* are emitted exactly as received. Normalizing keys would change the
 * bytes of any payload carrying a decomposed key, and would let two distinct
 * keys collapse into one member name.
 *
 * Numbers are integers within the safe range. A fractional or oversized
 * number has no single canonical spelling both implementations agree on, so
 * it is refused rather than hashed into an identifier the reference would
 * never produce. The conformance vectors in `__fixtures__` are the contract;
 * the test executes them.
 *
 * Keys sort by UTF-16 code units, which is what JS string comparison already
 * does — on the received spelling, not a normalized one.
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
        if (!Number.isInteger(value))
            throw new Error(`JCS: non-integer number: ${value}`)
        if (!Number.isSafeInteger(value))
            throw new Error(`JCS: integer outside the safe range: ${value}`)
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
        // Keys as received: sorted and emitted on their own spelling, never a
        // normalized one. Undefined values are not dropped — they fall through
        // to the non-JSON throw rather than silently changing the member set.
        const keys = Object.keys(rec).sort((a, b) =>
            a < b ? -1 : a > b ? 1 : 0,
        )
        const parts = keys.map(
            k => `${JSON.stringify(k)}:${serialize(rec[k], seen)}`,
        )
        out = `{${parts.join(",")}}`
    }
    seen.delete(obj)
    return out
}
