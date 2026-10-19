export const LOOPBACK_HOSTS = new Set([
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "::",
    "::1",
    "[::1]",
    "host.docker.internal",
])

/**
 * The compressed form of an IPv6 address, so 0:0:0:0:0:0:0:1 is compared as
 * ::1. A numeric IPv4 spelling (127.1, 0177.0.0.1, 2130706433) needs no
 * handling here: the URL parser has folded it before a hostname gets this far.
 */
function canonicalIpv6(host: string): string {
    if (!host.includes(":")) return host
    try {
        return stripBrackets(new URL(`http://[${host}]`).hostname)
    } catch (_e) {
        return host
    }
}

// Plain scans, not regular expressions: these run on hostnames a peer
// advertises, and an unanchored or repeated pattern over a long hostile
// string is quadratic where a scan is linear.
function stripBrackets(host: string): string {
    const from = host.startsWith("[") ? 1 : 0
    const to = host.endsWith("]") ? host.length - 1 : host.length
    return host.slice(from, Math.max(from, to))
}

function stripZoneId(host: string): string {
    const at = host.indexOf("%")
    return at < 0 ? host : host.slice(0, at)
}

function stripTrailingDots(host: string): string {
    let end = host.length
    while (end > 0 && host.charCodeAt(end - 1) === 46) end--
    return host.slice(0, end)
}

function isDecimalOctet(part: string): boolean {
    if (part.length === 0 || part.length > 3) return false
    for (const ch of part) if (ch < "0" || ch > "9") return false
    return true
}

/** Four dotted decimal groups inside 127/8, whatever the later groups hold. */
function isLoopbackBlock(host: string): boolean {
    const parts = host.split(".")
    return parts.length === 4 && parts[0] === "127" && parts.slice(1).every(isDecimalOctet)
}

export function isLoopbackHost(hostname: string): boolean {
    if (typeof hostname !== "string") return false

    // A trailing dot is the absolute form of the same name, and a zone id
    // (::1%lo) scopes an address without changing which one it is.
    const trimmed = stripTrailingDots(stripZoneId(stripBrackets(hostname.trim().toLowerCase())))
    if (trimmed === "") return false

    // Resolvers send every name under .localhost to the loopback interface.
    if (trimmed.endsWith(".localhost")) return true

    const host = canonicalIpv6(trimmed)
    if (LOOPBACK_HOSTS.has(host)) return true
    // The whole 127/8 block loops back, not only .0.0.1, and so does its
    // IPv4-mapped IPv6 form, which the URL parser rewrites to hex
    // (::ffff:127.0.0.1 becomes ::ffff:7f00:1); a name from that block is
    // every machine's own.
    const mapped = host.startsWith("::ffff:") ? host.slice("::ffff:".length) : host
    return isLoopbackBlock(mapped) || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host)
}

/**
 * Strict parser for node connection strings. The WHATWG parser silently
 * accepts and normalises forms like "http:host:port"; other clients (axios)
 * do not, so only "http(s)://host[:port]" with no path, query, hash or
 * credentials is accepted.
 */
export function parseNodeUrl(value: unknown): URL | null {
    if (typeof value !== "string" || !/^https?:\/\//i.test(value)) {
        return null
    }

    let url: URL
    try {
        url = new URL(value)
    } catch (_e) {
        return null
    }

    if (
        !url.hostname ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/"
    ) {
        return null
    }

    return url
}

/**
 * Validates EXPOSED_URL at config load and returns its normalised origin.
 * Malformed values are always fatal. Loopback hosts and a missing value are
 * fatal when prod is true and a warning otherwise.
 */
export function validateExposedUrl(
    value: string,
    prod: boolean,
    serverPort: number,
): string {
    if (!value) {
        if (prod) {
            throw new Error(
                "[config] EXPOSED_URL must be set when PROD=true. Use the public URL peers can reach, e.g. http://YOUR_IP:53550",
            )
        }
        console.warn(
            `[config] EXPOSED_URL is not set; defaulting to http://localhost:${serverPort}. Other peers cannot reach this node.`,
        )
        return `http://localhost:${serverPort}`
    }

    const url = parseNodeUrl(value)
    if (!url) {
        throw new Error(
            `[config] EXPOSED_URL is not a valid node URL: "${value}". Expected http(s)://host:port with no path.`,
        )
    }

    if (isLoopbackHost(url.hostname)) {
        const problem = `EXPOSED_URL points at a loopback/unroutable host: ${value}. Other peers cannot reach this node.`
        if (prod) {
            throw new Error(
                `[config] ${problem} Set EXPOSED_URL to your public IP or DNS name.`,
            )
        }
        console.warn(`[config] ${problem}`)
    }

    return url.origin
}

/**
 * Build provenance is exposed over /info and /version. A deployed node
 * without a resolvable commit cannot be audited, so it is fatal under
 * PROD and a warning otherwise.
 */
export function validateBuildProvenance(
    commit: string | null,
    prod: boolean,
): void {
    if (commit) {
        return
    }
    const problem =
        "the running commit could not be resolved (no .git/ in the runtime tree and GIT_COMMIT is unset). " +
        "Build the image through scripts/docker-run or pass GIT_COMMIT explicitly."
    if (prod) {
        throw new Error(`[config] PROD=true requires build provenance: ${problem}`)
    }
    console.warn(`[config] ${problem} /info will report commit=null.`)
}
