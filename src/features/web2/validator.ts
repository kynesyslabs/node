export type UrlValidationResult =
    | { ok: true; normalizedUrl: string }
    | { ok: false; status: 400; message: string }

/**
 * Validate and normalize a URL for DAHR.
 * - Trims whitespace
 * - Ensures protocol is http(s)
 * - Rejects URLs with embedded credentials (username/password)
 * - Rejects URLs without a hostname
 * - Rejects localhost and loopback IP addresses/hostnames (SSRF protection)
 * - Lowercases host, strips default ports, and removes fragments for canonicalization
 * - Redacts sensitive data in error messages (does not echo the full URL)
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

        // 1. Ensure protocol is http(s)
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return {
                ok: false,
                status: 400,
                message: "Invalid URL scheme. Only http(s) are allowed",
            }
        }

        // 2. Reject URLs with embedded credentials (username/password)
        if (parsed.username || parsed.password) {
            return {
                ok: false,
                status: 400,
                message: "Invalid URL: embedded credentials are not allowed",
            }
        }

        // 3. Reject URLs without a hostname
        if (!parsed.hostname) {
            return {
                ok: false,
                status: 400,
                message: "Invalid URL: URL must have a hostname",
            }
        }

        const hostLower = parsed.hostname.toLowerCase()

        // 4. Reject localhost and loopback hostnames
        if (hostLower === "localhost" || hostLower.endsWith(".localhost")) {
            return {
                ok: false,
                status: 400,
                message: "Localhost targets are not allowed",
            }
        }

        // 5. Basic loopback check for IPv4 and IPv6
        const isIPv6Loopback = hostLower === "::1" || hostLower === "[::1]"
        const isIPv4Loopback = /^127(?:\.\d{1,3}){3}$/.test(hostLower)
        if (isIPv4Loopback || isIPv6Loopback) {
            return {
                ok: false,
                status: 400,
                message: "Loopback targets are not allowed",
            }
        }

        // 6. Canonicalize the URL (lowercase host, strip default ports, remove fragment)
        const canonicalUrlObject = new URL(parsed.toString())
        canonicalUrlObject.hostname = canonicalUrlObject.hostname.toLowerCase()

        // Strip default ports
        if (
            (canonicalUrlObject.protocol === "http:" &&
                canonicalUrlObject.port === "80") ||
            (canonicalUrlObject.protocol === "https:" &&
                canonicalUrlObject.port === "443")
        ) {
            canonicalUrlObject.port = ""
        }

        // Remove fragment
        canonicalUrlObject.hash = ""

        return { ok: true, normalizedUrl: canonicalUrlObject.toString() }
    } catch {
        return { ok: false, status: 400, message: "Invalid URL format" }
    }
}
