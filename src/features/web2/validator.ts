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
 * - Rejects a URL that is longer than SESSION_URL_MAX_CHARS once normalized
 * - Redacts sensitive data in error messages (does not echo the full URL)
 */
import net from "node:net"
import { isPublicAddress } from "src/utilities/outboundAddress"
import { SESSION_URL_MAX_CHARS } from "./dahr/sessionLimit"

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

        // 5. Block IP literals outside public unicast space. The URL parser
        // keeps the brackets on an IPv6 host and has already turned the
        // shorthand IPv4 forms into dotted quads, so only bracketed IPv6 and
        // dotted IPv4 reach here. Names are checked where they resolve.
        const bareHost = hostLower.replace(/^\[(.*)\]$/, "$1")
        if (net.isIP(bareHost) !== 0 && !isPublicAddress(bareHost)) {
            return {
                ok: false,
                status: 400,
                message:
                    "Private, link-local, or loopback targets are not allowed",
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

        // 7. Limit the length of what the session's relay then holds.
        // Measured here: percent-encoding makes a URL longer than it was sent.
        const normalizedUrl = canonicalUrlObject.toString()
        if (normalizedUrl.length > SESSION_URL_MAX_CHARS) {
            return {
                ok: false,
                status: 400,
                message: `Invalid URL: longer than ${SESSION_URL_MAX_CHARS} characters`,
            }
        }

        return { ok: true, normalizedUrl }
    } catch {
        return { ok: false, status: 400, message: "Invalid URL format" }
    }
}
