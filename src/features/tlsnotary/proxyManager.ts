/**
 * TLSNotary proxy manager: checks the relay target and opens one in-process
 * relay session per granted request (see proxyRelay.ts). Who may ask, and
 * how often, is decided before this module runs (proxyAccess.ts).
 *
 * @module features/tlsnotary/proxyManager
 */
import log from "@/utilities/logger"
import { getSharedState } from "@/utilities/sharedState"
import { Config } from "src/config"
import {
    DisallowedAddressError,
    resolvePublicAddress,
} from "@/utilities/outboundAddress"
import {
    endAllRelaySessions,
    endRelaySession,
    getTLSNotaryState,
    liveSessions,
    openRelaySession,
    type RelayLimits,
} from "./proxyRelay"

export type { TLSNotaryState } from "./proxyRelay"

export enum ProxyError {
    PROXY_SPAWN_FAILED = "PROXY_SPAWN_FAILED",
    PORT_EXHAUSTED = "PORT_EXHAUSTED",
    INVALID_URL = "INVALID_URL",
    TARGET_NOT_ALLOWED = "TARGET_NOT_ALLOWED",
}

export interface ProxyRequestSuccess {
    /** Carries the session's secret id as its last path segment. */
    websocketProxyUrl: string
    targetDomain: string
    /** Milliseconds until the session ends whatever it relays. */
    expiresIn: number
    proxyId: string
    maxSentBytes: number
    maxRecvBytes: number
}

export interface ProxyRequestError {
    error: ProxyError
    message: string
    targetDomain?: string
    lastError?: string
}

export interface ProxyRequest {
    targetUrl: string
    requestOrigin?: string
    tokenId: string
    owner: string
    clientKey: string
    limits: RelayLimits
}

/**
 * Extract domain and port from a target URL
 * @param targetUrl - Full URL like "https://api.example.com:8443/endpoint"
 * @returns Domain and port extracted from URL
 */
export function extractDomainAndPort(targetUrl: string): {
    domain: string
    port: number
} {
    try {
        const url = new URL(targetUrl)
        const domain = url.hostname

        // If explicit port in URL, use it
        if (url.port) {
            return { domain, port: parseInt(url.port, 10) }
        }

        // Otherwise infer from protocol
        const port = url.protocol === "https:" ? 443 : 80
        return { domain, port }
    } catch {
        throw new Error(`Invalid URL: ${targetUrl}`)
    }
}

/**
 * Build a public WebSocket URL from a base HTTP(S)/WS(S) URL and a local port.
 * Local bases keep direct ws://localhost:<port> URLs for development. Public
 * bases always route through a TLS reverse proxy path, defaulting to
 * /tlsn/<port>/ when no explicit path is provided.
 */
export function buildWsUrl(base: string, port: number | string): string {
    const url = new URL(base)
    const isLocal =
        url.hostname === "localhost" || url.hostname === "127.0.0.1"

    if (isLocal) {
        return `ws://${url.hostname}:${port}`
    }

    const path = url.pathname.replace(/\/+$/, "") || "/tlsn"
    return `wss://${url.hostname}${path}/${port}/`
}

/**
 * Build the public WebSocket URL for the proxy
 * @param localPort - Local port the proxy is listening on
 * @param requestOrigin - Optional request origin for auto-detection
 * @returns WebSocket URL like "ws://node.demos.sh:55123"
 */
export function getPublicUrl(
    localPort: number,
    requestOrigin?: string,
): string {
    // 1. Try auto-detect from request origin (if available in headers)
    if (requestOrigin) {
        try {
            return buildWsUrl(requestOrigin, localPort)
        } catch {
            // Invalid origin, continue to fallback
        }
    }

    // 2. Fall back to EXPOSED_URL
    if (process.env.EXPOSED_URL) {
        try {
            return buildWsUrl(process.env.EXPOSED_URL, localPort)
        } catch {
            // Invalid EXPOSED_URL, continue to fallback
        }
    }

    // 3. Fall back to sharedState.exposedUrl
    try {
        return buildWsUrl(getSharedState.exposedUrl, localPort)
    } catch {
        // Last resort: localhost
        return `ws://localhost:${localPort}`
    }
}

export async function checkRelayTarget(
    domain: string,
    targetPort: number,
): Promise<{ dialHost: string } | ProxyRequestError> {
    const { tlsnotaryAllowedPorts, tlsnotaryAllowPrivateTargets } =
        Config.getInstance().outbound
    if (!tlsnotaryAllowedPorts.includes(targetPort)) {
        return {
            error: ProxyError.TARGET_NOT_ALLOWED,
            message: `Target port ${targetPort} is not allowed (TLSNOTARY_ALLOWED_PORTS)`,
            targetDomain: domain,
        }
    }
    if (tlsnotaryAllowPrivateTargets) return { dialHost: domain }

    try {
        return { dialHost: await resolvePublicAddress(domain) }
    } catch (err: any) {
        if (err instanceof DisallowedAddressError) {
            return {
                error: ProxyError.TARGET_NOT_ALLOWED,
                message: err.message,
                targetDomain: domain,
            }
        }
        return {
            error: ProxyError.INVALID_URL,
            message: `Cannot resolve ${domain}: ${err?.code ?? err?.message}`,
            targetDomain: domain,
        }
    }
}

/**
 * The websocket URL of a session: the public URL of its port with the
 * session id appended as the last path segment.
 */
export function sessionProxyUrl(
    port: number,
    sessionId: string,
    requestOrigin?: string,
): string {
    return `${getPublicUrl(port, requestOrigin).replace(/\/+$/, "")}/${sessionId}`
}

/** Opens a relay session to the target URL's host for an authorised caller. */
export async function requestProxy(
    request: ProxyRequest,
): Promise<ProxyRequestSuccess | ProxyRequestError> {
    let domain: string
    let targetPort: number
    try {
        const extracted = extractDomainAndPort(request.targetUrl)
        domain = extracted.domain
        targetPort = extracted.port
    } catch (err: any) {
        return { error: ProxyError.INVALID_URL, message: err.message }
    }

    // The relay is a raw TCP tunnel from this host, so only public
    // addresses on allowed ports; it dials the address checked here, not
    // the name, so a later DNS answer cannot redirect it.
    const target = await checkRelayTarget(domain, targetPort)
    if ("error" in target) return target

    const session = await openRelaySession({
        tokenId: request.tokenId,
        owner: request.owner,
        clientKey: request.clientKey,
        domain,
        dialHost: target.dialHost,
        targetPort,
        limits: request.limits,
    })
    if (session === "exhausted") {
        return {
            error: ProxyError.PORT_EXHAUSTED,
            message: "Every proxy port of this node is in use",
            targetDomain: domain,
        }
    }
    if (session === null) {
        return {
            error: ProxyError.PROXY_SPAWN_FAILED,
            message: "Could not bind a proxy port",
            targetDomain: domain,
        }
    }
    return {
        websocketProxyUrl: sessionProxyUrl(
            session.port,
            session.sessionId,
            request.requestOrigin,
        ),
        targetDomain: domain,
        expiresIn: request.limits.maxLifetimeMs,
        proxyId: session.proxyId,
        maxSentBytes: request.limits.maxSentBytes,
        maxRecvBytes: request.limits.maxRecvBytes,
    }
}

/** Ends one session by its public id; false when none is live. */
export function killProxy(proxyId: string): boolean {
    const session = getTLSNotaryState().sessions.get(proxyId)
    if (!session) return false
    log.info(`[TLSNotary] Killing proxy ${proxyId} for ${session.domain}`)
    endRelaySession(session, "shutdown")
    return true
}

export function killAllProxies(): void {
    endAllRelaySessions()
}

export function getProxyManagerStatus(): {
    activeProxies: number
    proxies: Array<{
        proxyId: string
        domain: string
        port: number
        idleSeconds: number
        bytesSent: number
        bytesRecv: number
    }>
} {
    const now = Date.now()
    const proxies = liveSessions().map(p => ({
        proxyId: p.proxyId,
        domain: p.domain,
        port: p.port,
        idleSeconds: Math.floor((now - p.lastActivity) / 1000),
        bytesSent: p.bytesSent,
        bytesRecv: p.bytesRecv,
    }))
    return { activeProxies: proxies.length, proxies }
}
