// A plain shape rather than a union: the repo builds without strictNullChecks,
// where TypeScript cannot narrow a union on `ok`.
export interface Result<T> {
    ok: boolean
    value?: T
    error?: string
}

const ok = <T>(value: T): Result<T> => ({ ok: true, value })
const fail = <T>(error: string): Result<T> => ({ ok: false, error })

// Identical to the check in ParallelNetworks.loadL2PS: a uid the loader
// refuses would silently never join, so the setup must not accept it either.
export const SUBNET_UID_PATTERN = /^[A-Za-z0-9_-]+$/

export function validateUid(value: string): Result<string> {
    const uid = value.trim()
    if (!SUBNET_UID_PATTERN.test(uid)) {
        return fail("Use letters, digits, underscore or dash")
    }
    return ok(uid)
}

/**
 * Same normalisation as the loader's hexFileToBytes: trim, drop a 0x prefix,
 * drop every whitespace character. Returns lowercase hex.
 */
export function normalizeHex(value: string): string {
    return value
        .trim()
        .replace(/^0x/i, "")
        .replaceAll(/\s+/g, "")
        .toLowerCase()
}

/** Format only: what makes the loader throw. Length is checked separately. */
export function parseHex(value: string, label: string): Result<string> {
    const cleaned = normalizeHex(value)
    if (cleaned.length === 0) return fail(`${label} is empty`)
    if (!/^[0-9a-f]+$/.test(cleaned)) {
        return fail(`${label} contains non-hex characters`)
    }
    if (cleaned.length % 2 !== 0) {
        return fail(`${label} hex length must be even`)
    }
    return ok(cleaned)
}

/** A warning text when the byte length is not one the cipher takes, else null. */
export function hexLengthWarning(
    hex: string,
    label: string,
    allowedBytes: number[],
): string | null {
    const bytes = hex.length / 2
    return allowedBytes.includes(bytes)
        ? null
        : `${label} is ${bytes} bytes; expected ${allowedBytes.join(" or ")}`
}

/** Strict form used for new input: format and length must both be right. */
export function validateHex(
    value: string,
    label: string,
    allowedBytes: number[],
): Result<string> {
    const parsed = parseHex(value, label)
    if (!parsed.ok) return parsed
    const warning = hexLengthWarning(parsed.value, label, allowedBytes)
    return warning === null ? parsed : fail(warning)
}

// AES key sizes the cipher accepts; new keys are always 32 bytes.
export const KEY_BYTES = [16, 24, 32]
export const IV_BYTES = [12, 16]

export const validateKeyHex = (v: string) => validateHex(v, "Key", KEY_BYTES)
export const validateIvHex = (v: string) => validateHex(v, "IV", IV_BYTES)

export function validateRpcUrl(value: string): Result<string> {
    const raw = value.trim()
    let url: URL
    try {
        url = new URL(raw)
    } catch {
        return fail(`"${raw}" is not a valid URL`)
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        return fail(`"${raw}" must start with http:// or https://`)
    }
    return ok(raw.replace(/\/+$/, ""))
}

/** Comma or whitespace separated list of RPC URLs; at least one. */
export function validateRpcList(value: string | string[]): Result<string[]> {
    const parts = (Array.isArray(value) ? value : [value])
        .flatMap(v => v.split(/[,\s]+/))
        .filter(Boolean)
    if (parts.length === 0) return fail("Give at least one RPC URL")
    const urls: string[] = []
    for (const part of parts) {
        const r = validateRpcUrl(part)
        if (!r.ok) return fail(r.error)
        if (!urls.includes(r.value)) urls.push(r.value)
    }
    return ok(urls)
}

export function validatePort(value: string): Result<number> {
    if (!/^\d+$/.test(value.trim())) return fail("Port must be a number")
    const port = Number(value)
    if (port < 1 || port > 65535) return fail("Port must be 1-65535")
    return ok(port)
}

export function validateNonNegativeInt(value: string): Result<number> {
    if (!/^\d+$/.test(value.trim())) {
        return fail("Enter a whole number, 0 or more")
    }
    return ok(Number(value))
}

export function parseBool(value: string | undefined): boolean | undefined {
    if (value === undefined) return undefined
    const v = value.trim().toLowerCase()
    if (["true", "1", "yes", "y", "on"].includes(v)) return true
    if (["false", "0", "no", "n", "off"].includes(v)) return false
    return undefined
}
