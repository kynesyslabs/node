// Boot check for the Caddy proxy profile (docker-compose.proxy.yml). Caddy
// ships a bcrypt hash that rejects every password; an operator who forgets to
// set METRICS_BASIC_AUTH_HASH / MCP_BASIC_AUTH_HASH gets a proxy that answers
// 401 to everyone with nothing in any log. The compose override hands the node
// PROXY_ENABLED=true and the two hash variables so the node can refuse to boot
// instead. Pure functions: no side effects.

import { parseBoolFlag } from "./envFlags"

/** Substring of the sentinel hash baked into the compose file and Caddyfile. */
const PLACEHOLDER_MARKER = "invalidinvalid"

/** A hash is a placeholder when it is unset, empty or still the shipped sentinel. */
export function isPlaceholderAuthHash(raw: string | undefined): boolean {
    const value = raw?.trim() ?? ""
    return value === "" || value.includes(PLACEHOLDER_MARKER)
}

/**
 * Names of the basic-auth variables that still hold the placeholder on a
 * proxy-enabled deployment. Empty when the deployment is not proxy-enabled, when
 * PROXY_ALLOW_PLACEHOLDER_AUTH=true (the operator wants the route closed), or
 * when the route the hash protects is off: /metrics needs METRICS_BASIC_AUTH_HASH
 * unless METRICS_ENABLED=false, /mcp needs MCP_BASIC_AUTH_HASH only with MCP_ENABLED=true.
 */
export function findProxyAuthPlaceholders(
    env: Record<string, string | undefined>,
): string[] {
    if (parseBoolFlag(env.PROXY_ENABLED) !== true) return []
    if (parseBoolFlag(env.PROXY_ALLOW_PLACEHOLDER_AUTH) === true) return []

    const found: string[] = []
    if (
        parseBoolFlag(env.METRICS_ENABLED) !== false &&
        isPlaceholderAuthHash(env.METRICS_BASIC_AUTH_HASH)
    ) {
        found.push("METRICS_BASIC_AUTH_HASH")
    }
    if (
        parseBoolFlag(env.MCP_ENABLED) === true &&
        isPlaceholderAuthHash(env.MCP_BASIC_AUTH_HASH)
    ) {
        found.push("MCP_BASIC_AUTH_HASH")
    }
    return found
}
