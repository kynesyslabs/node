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
import net from "node:net"

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

        // 5. Block loopback and private/link-local/reserved ranges (IPv4, IPv6, and IPv4-mapped IPv6)
        const ipVersion = net.isIP(hostLower)
        const isIPv6Unspecified = hostLower === "::"
        const isIPv6Loopback = hostLower === "::1"
        const isIPv6Multicast = hostLower.startsWith("ff")
        const isIPv4MappedLoopback = hostLower.startsWith("::ffff:127.")
        const isIPv4Loopback = /^127(?:\.\d{1,3}){3}$/.test(hostLower)
        const isIPv4Private =
            /^10\./.test(hostLower) ||
            (/^172\.(\d{1,3})\./.test(hostLower) &&
                (() => {
                    const ipMatch = hostLower.match(/^172\.(\d{1,3})\./)
                    if (!ipMatch) return false
                    const secondOctet = Number(ipMatch[1])
                    return secondOctet >= 16 && secondOctet <= 31
                })()) ||
            /^192\.168\./.test(hostLower) ||
            /^169\.254\./.test(hostLower) ||
            /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(hostLower) || // 100.64.0.0/10
            /^0\./.test(hostLower)
        const isIPv6ULAorLL =
            ipVersion === 6 &&
            (hostLower.startsWith("fc") ||
                hostLower.startsWith("fd") ||
                /^fe[89ab][0-9a-f]*:/i.test(hostLower))
        // Also block IPv4-mapped private ranges (::ffff:10.x, ::ffff:172.16-31.x, ::ffff:192.168.x, ::ffff:169.254.x, ::ffff:100.64-127.x)
        const mappedMatch = hostLower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
        let isMappedPrivate = false
        if (mappedMatch) {
            const v4 = mappedMatch[1]
            if (/^127(?:\.\d{1,3}){3}$/.test(v4)) isMappedPrivate = true
            if (/^10\./.test(v4)) isMappedPrivate = true
            const m172 = v4.match(/^172\.(\d{1,3})\./)
            if (m172) {
                const secondOctet = Number(m172[1])
                if (secondOctet >= 16 && secondOctet <= 31) isMappedPrivate = true
            }
            if (/^192\.168\./.test(v4)) isMappedPrivate = true
            if (/^169\.254\./.test(v4)) isMappedPrivate = true
            if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(v4))
                isMappedPrivate = true
            if (/^0\./.test(v4)) isMappedPrivate = true
        }
        if (
            isIPv6Unspecified ||
            isIPv6Loopback ||
            isIPv6Multicast ||
            isIPv4MappedLoopback ||
            isIPv4Loopback ||
            isIPv4Private ||
            isMappedPrivate ||
            isIPv6ULAorLL
        ) {
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

        return { ok: true, normalizedUrl: canonicalUrlObject.toString() }
    } catch {
        return { ok: false, status: 400, message: "Invalid URL format" }
    }
}
