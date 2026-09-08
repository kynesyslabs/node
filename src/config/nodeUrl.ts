export const LOOPBACK_HOSTS = new Set([
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "::1",
    "[::1]",
    "host.docker.internal",
])

export function isLoopbackHost(hostname: string): boolean {
    return LOOPBACK_HOSTS.has(hostname.toLowerCase())
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
