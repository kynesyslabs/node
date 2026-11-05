/**
 * Canonical JSON for arbitrary stored data (storage program records, their
 * payloads): one spelling per JSON value, so a state root computed over it is
 * the same on every node.
 *
 * It is deliberately not `jcsCanonicalize`. JCS refuses non-integer numbers
 * and NFC-normalizes string values; stored data may carry floats, and
 * normalizing would make two different stored strings hash the same while
 * the node still serves different bytes for them.
 *
 * Rules:
 * - Object keys sort by UTF-16 code units (the default `Array.prototype.sort`
 *   order) on their spelling as stored. Arrays keep their order.
 * - Strings, numbers and booleans are spelled by `JSON.stringify`: ECMAScript
 *   number-to-string for finite numbers (so `-0` is `0`, `1e21` is `1e+21`),
 *   and lone surrogates escaped as `\udXXX`. No Unicode normalization.
 * - The value model is JSON's: `toJSON` is honoured (a `Date` becomes its ISO
 *   string), object members whose value is undefined, a function or a symbol
 *   are omitted, and such array elements become `null`. So the canonical form
 *   of a value equals that of its `JSON.parse(JSON.stringify(...))` round trip,
 *   which is what a row read back from the database is.
 *
 * It throws where JSON would lose data silently or where there is no JSON
 * spelling: undefined (or a function or symbol) at the top level, non-finite
 * numbers (`JSON.stringify` turns them into `null`), bigint (no JSON number
 * represents it exactly; callers store it as a decimal string), a `Map`,
 * `Set` or binary buffer (serialized as `{}` by `JSON.stringify`), and cycles.
 * Shared, non-cyclic references are fine.
 */
/**
 * Orders strings by UTF-16 code units, the order of a comparator-less
 * `Array.prototype.sort`. Never `localeCompare`: a locale-dependent order
 * would give nodes in different locales different bytes.
 */
export function compareCodeUnits(a: string, b: string): number {
    if (a < b) return -1
    if (a > b) return 1
    return 0
}

export function canonicalJson(value: unknown): string {
    const out = serialize(value, "", [])
    if (out === undefined) {
        throw new Error(`canonicalJson: top-level value has no JSON form: ${typeof value}`)
    }
    return out
}

function serialize(raw: unknown, key: string, ancestors: object[]): string | undefined {
    let value = raw
    if (
        value !== null &&
        (typeof value === "object" || typeof value === "bigint") &&
        typeof (value as { toJSON?: unknown }).toJSON === "function"
    ) {
        value = (value as { toJSON: (k: string) => unknown }).toJSON(key)
    }
    if (value instanceof Number || value instanceof String || value instanceof Boolean) {
        value = value.valueOf()
    }

    if (value === null) return "null"
    switch (typeof value) {
        case "string":
        case "boolean":
            return JSON.stringify(value)
        case "number":
            if (!Number.isFinite(value)) {
                throw new TypeError(`canonicalJson: non-finite number: ${value}`)
            }
            return JSON.stringify(value)
        case "bigint":
            throw new TypeError("canonicalJson: bigint has no JSON form; store it as a decimal string")
        case "undefined":
        case "function":
        case "symbol":
            return undefined
    }

    const obj = value as object
    if (obj instanceof Map || obj instanceof Set || ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) {
        throw new TypeError(`canonicalJson: ${obj.constructor.name} has no faithful JSON form`)
    }
    if (ancestors.includes(obj)) throw new Error("canonicalJson: circular reference")
    ancestors.push(obj)
    try {
        if (Array.isArray(obj)) {
            // Array.from visits holes too, which map skips: JSON spells them null
            const items = Array.from(obj, (item, i) => serialize(item, String(i), ancestors) ?? "null")
            return `[${items.join(",")}]`
        }
        const record = obj as Record<string, unknown>
        const members: string[] = []
        for (const k of Object.keys(record).sort(compareCodeUnits)) {
            const v = serialize(record[k], k, ancestors)
            if (v !== undefined) members.push(`${JSON.stringify(k)}:${v}`)
        }
        return `{${members.join(",")}}`
    } finally {
        ancestors.pop()
    }
}
