// A plain shape rather than a union: the repo builds without strictNullChecks,
// where TypeScript cannot narrow a union on `ok`.
export interface Result<T> {
    ok: boolean
    value?: T
    error?: string
}

const ok = <T>(value: T): Result<T> => ({ ok: true, value })
const fail = <T>(error: string): Result<T> => ({ ok: false, error })

// The node loader accepts [A-Za-z0-9_-]+ only; a dot would be rejected at boot.
export const SUBNET_UID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export function validateUid(value: string): Result<string> {
    const uid = value.trim()
    if (!SUBNET_UID_PATTERN.test(uid)) {
        return fail(
            "Use 1-64 characters: letters, digits, underscore or dash",
        )
    }
    return ok(uid)
}

/** Accepts optional 0x prefix and surrounding whitespace; returns lowercase hex. */
export function validateHex(
    value: string,
    label: string,
    allowedBytes: number[],
): Result<string> {
    const cleaned = value.trim().replace(/^0x/i, "")
    if (cleaned.length === 0) return fail(`${label} is empty`)
    if (!/^[0-9a-fA-F]+$/.test(cleaned)) {
        return fail(`${label} must be hexadecimal`)
    }
    if (cleaned.length % 2 !== 0) {
        return fail(`${label} must have an even number of hex digits`)
    }
    const bytes = cleaned.length / 2
    if (!allowedBytes.includes(bytes)) {
        return fail(
            `${label} must be ${allowedBytes.join(" or ")} bytes (${allowedBytes
                .map(b => b * 2)
                .join(" or ")} hex digits), got ${bytes}`,
        )
    }
    return ok(cleaned.toLowerCase())
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
