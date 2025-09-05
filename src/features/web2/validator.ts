export type UrlValidationResult =
    | { ok: true; normalizedUrl: string }
    | { ok: false; status: 400; message: string }

/**
 * Validate and normalize a URL for DAHR.
 * - Trims whitespace
 * - Ensures protocol is http(s)
 */
export function validateAndNormalizeHttpUrl(
    input: string,
): UrlValidationResult {
    const trimmed = (input ?? "").trim()
    if (!trimmed) {
        return { ok: false, status: 400, message: "Invalid URL: empty value" }
    }
    try {
        const parsed = new URL(trimmed)
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return {
                ok: false,
                status: 400,
                message: "Invalid URL scheme. Only http(s) are allowed",
            }
        }
        return { ok: true, normalizedUrl: parsed.toString() }
    } catch {
        return { ok: false, status: 400, message: "Invalid URL format" }
    }
}
