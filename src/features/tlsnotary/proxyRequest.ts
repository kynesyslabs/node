/**
 * The requestTLSNproxy nodeCall: authorise the caller (proxyAccess.ts), then
 * open one relay session sized to this node's notary limits.
 *
 * @module features/tlsnotary/proxyRequest
 */
import { Config } from "src/config"
import log from "@/utilities/logger"
import { PROXY_LIMITS, proxyByteCaps } from "./constants"
import { authorizeProxyRequest } from "./proxyAccess"
import { requestProxy } from "./proxyManager"
import { endRelaySession } from "./proxyRelay"

const PROXY_ERROR_STATUS: Record<string, number> = {
    INVALID_URL: 400,
    TARGET_NOT_ALLOWED: 403,
    PORT_EXHAUSTED: 503,
    PROXY_SPAWN_FAILED: 500,
}

/**
 * requestTLSNproxy: opens one relay session for a confirmed tlsn_request the
 * signer of this call sent. The response body carries `status` only on a
 * refusal.
 */
export async function requestTlsnProxy(
    data: { tokenId?: unknown; owner?: unknown; targetUrl?: unknown; requestOrigin?: unknown },
    sender: string,
    clientIP?: string,
): Promise<Record<string, unknown>> {
    const fail = (status: number, error: string, message: string) => ({ status, error, message })
    try {
        if (!Config.getInstance().tlsnotary.enabled) {
            return fail(503, "PROXY_DISABLED", "This node does not serve TLSNotary proxies")
        }
        const targetUrl = typeof data.targetUrl === "string" ? data.targetUrl : ""
        if (!targetUrl) return fail(400, "INVALID_REQUEST", "Missing targetUrl parameter")
        if (!targetUrl.startsWith("https://")) {
            return fail(400, "INVALID_URL", "Only HTTPS URLs are supported for TLS attestation")
        }
        if (data.tokenId === undefined || data.tokenId === null || data.tokenId === "") {
            return fail(400, "INVALID_REQUEST", "Missing tokenId parameter")
        }

        const grant = await authorizeProxyRequest({
            tokenId: data.tokenId,
            owner: data.owner,
            sender,
            targetUrl,
            clientIP,
        })
        if ("error" in grant) return fail(grant.status, grant.error, grant.message)

        try {
            if (grant.supersedes) endRelaySession(grant.supersedes, "superseded")
            const cfg = Config.getInstance().tlsnotary
            const result = await requestProxy({
                targetUrl,
                requestOrigin:
                    typeof data.requestOrigin === "string" ? data.requestOrigin : undefined,
                tokenId: grant.txHash,
                owner: grant.owner,
                clientKey: grant.clientKey,
                limits: {
                    maxLifetimeMs: Math.min(
                        PROXY_LIMITS.SESSION_MAX_LIFETIME_MS,
                        grant.expiresAtMs - Date.now(),
                    ),
                    idleMs: PROXY_LIMITS.SESSION_IDLE_MS,
                    ...proxyByteCaps(cfg.maxSentData, cfg.maxRecvData),
                },
            })
            if ("error" in result) {
                grant.release()
                return {
                    status: PROXY_ERROR_STATUS[result.error] ?? 500,
                    ...result,
                }
            }
            grant.commit(result.proxyId)
            log.info(
                `[TLSNotary] Proxy ${result.proxyId} opened for token ${grant.txHash} (${grant.sessionsLeft} sessions left)`,
            )
            return {
                ...result,
                tokenId: grant.txHash,
                retriesLeft: grant.sessionsLeft,
            }
        } catch (error) {
            grant.release()
            throw error
        }
    } catch (error) {
        log.error("[manageNodeCall] requestTLSNproxy error: " + error)
        return fail(500, "INTERNAL_ERROR", "Failed to request TLSNotary proxy")
    }
}
