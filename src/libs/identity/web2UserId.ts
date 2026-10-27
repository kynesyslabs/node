/**
 * One comparable form for a web2 account id. Clients send ids as JSON numbers
 * (GitHub) or strings (Twitter, Discord), and the stored value keeps that
 * type, so every uniqueness check compares this form instead of the raw value.
 *
 * Accepted: a non-negative safe integer, or a decimal string with no
 * whitespace, sign or leading zero. Anything else returns null, so " 42 " or
 * "042" can never pass for a different account than "42".
 */
export function canonicalWeb2UserId(id: unknown): string | null {
    if (typeof id === "number") {
        return Number.isSafeInteger(id) && id >= 0 ? String(id) : null
    }
    if (typeof id === "string" && /^(0|[1-9][0-9]{0,31})$/.test(id)) {
        return id
    }
    return null
}

/** True when both ids are canonical and name the same account. */
export function sameWeb2UserId(a: unknown, b: unknown): boolean {
    const left = canonicalWeb2UserId(a)
    return left !== null && left === canonicalWeb2UserId(b)
}

/**
 * The text a stored id is looked up by. Stored ids are read with jsonb `->>`,
 * which renders the number 42 and the string "42" alike, so a canonical query
 * value matches both spellings. A value that is not canonical is passed
 * through unchanged and only matches the same text.
 */
export function web2UserIdLookupKey(id: unknown): string {
    return canonicalWeb2UserId(id) ?? String(id ?? "")
}
