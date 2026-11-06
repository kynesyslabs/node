import { Config } from "src/config"
import log from "@/utilities/logger"

const RPC_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"])

function isListed(url: URL, allowlist: readonly string[]): boolean {
    const host = url.hostname.toLowerCase()
    return allowlist.some(entry => {
        if (entry.includes("://")) {
            try {
                return new URL(entry).origin === url.origin
            } catch {
                return false
            }
        }
        return entry.toLowerCase() === host
    })
}

/**
 * The RPC URL an XM operation runs against: the node's configured one for the
 * chain, or the caller's only when the operator allow-listed its host (or full
 * origin). Honouring any caller URL would let a caller make the node fetch
 * arbitrary addresses, including the operator's private network.
 */
export function pickRpcUrl(
    callerUrl: unknown,
    configuredUrl: string | undefined,
    allowlist: readonly string[] = Config.getInstance().outbound.xmRpcAllowlist,
): string | undefined {
    if (typeof callerUrl !== "string" || callerUrl === "") return configuredUrl

    let parsed: URL
    try {
        parsed = new URL(callerUrl)
    } catch {
        return configuredUrl
    }
    if (RPC_SCHEMES.has(parsed.protocol) && isListed(parsed, allowlist)) {
        return callerUrl
    }
    log.debug(
        `[XM] Ignoring caller RPC URL for host ${parsed.hostname}: not in XM_RPC_ALLOWLIST`,
    )
    return configuredUrl
}
