import { Config } from "src/config"
import log from "src/utilities/logger"
import type { NodeCallHandler } from "./types"

export const tlsnotaryHandlers: Record<string, NodeCallHandler> = {
    requestTLSNproxy: async (data, response) => {
        try {
            const { requestProxy, ProxyError } = await import(
                "@/features/tlsnotary/proxyManager"
            )
            const { validateProxyToken, consumeRetry } = await import(
                "@/features/tlsnotary/tokenManager"
            )

            if (!data.tokenId || !data.owner) {
                response.result = 400
                response.response = {
                    error: "INVALID_REQUEST",
                    message: "Missing tokenId or owner parameter",
                }
                return response
            }

            if (!data.targetUrl) {
                response.result = 400
                response.response = {
                    error: "INVALID_REQUEST",
                    message: "Missing targetUrl parameter",
                }
                return response
            }

            if (!data.targetUrl.startsWith("https://")) {
                response.result = 400
                response.response = {
                    error: ProxyError.INVALID_URL,
                    message:
                        "Only HTTPS URLs are supported for TLS attestation",
                }
                return response
            }

            const validation = await validateProxyToken(
                data.tokenId,
                data.owner,
                data.targetUrl,
            )
            if (!validation.valid) {
                response.result =
                    validation.error === "TOKEN_NOT_FOUND" ? 404 : 403
                response.response = {
                    error: validation.error,
                    message: `Token validation failed: ${validation.error}`,
                    domain: validation.token?.domain,
                }
                return response
            }

            const result = await requestProxy(
                data.targetUrl,
                data.requestOrigin,
            )

            if ("error" in result) {
                switch (result.error) {
                    case ProxyError.INVALID_URL:
                        response.result = 400
                        break
                    case ProxyError.TARGET_NOT_ALLOWED:
                        response.result = 403
                        break
                    case ProxyError.PORT_EXHAUSTED:
                        response.result = 503
                        break
                    case ProxyError.WSTCP_NOT_AVAILABLE:
                    case ProxyError.PROXY_SPAWN_FAILED:
                    default:
                        response.result = 500
                        break
                }
                response.response = result
            } else {
                // The validated id: under tlsnVerified a 0x or upper-case
                // tokenId is the same chain token, and must spend its retries.
                const updatedToken = consumeRetry(
                    validation.token?.id ?? data.tokenId,
                    result.proxyId,
                )
                if (updatedToken) {
                    log.info(
                        `[TLSNotary] Proxy spawned for token ${data.tokenId}, retries left: ${updatedToken.retriesLeft}`,
                    )
                }

                response.response = {
                    ...result,
                    tokenId: data.tokenId,
                    retriesLeft: updatedToken?.retriesLeft ?? 0,
                }
            }
        } catch (error) {
            log.error("[manageNodeCall] requestTLSNproxy error: " + error)
            response.result = 500
            response.response = {
                error: "INTERNAL_ERROR",
                message: "Failed to request TLSNotary proxy",
            }
        }
        return response
    },

    "tlsnotary.getInfo": async (data, response) => {
        try {
            const { getTLSNotaryService } = await import(
                "@/features/tlsnotary"
            )
            const service = getTLSNotaryService()

            if (!service || !service.isRunning()) {
                response.result = 503
                response.response = {
                    success: false,
                    error: "TLSNotary service is not enabled or not running",
                }
                return response
            }

            const publicKey = service.getPublicKeyHex()
            const port = service.getPort()

            const proxyPort = Config.getInstance().tlsnotary.proxyPort

            const { getPublicUrl } = await import(
                "@/features/tlsnotary/proxyManager"
            )

            const notaryUrl = getPublicUrl(port)
            const proxyUrl = getPublicUrl(proxyPort)

            // The SDK refuses an oversize presentation before signing a
            // store with this cap; the chain refuses one over it anyway.
            const { tlsnVerifiedParams } = await import("@/forks/tlsnVerifiedGate")
            const { getSharedState } = await import("@/utilities/sharedState")
            const params = tlsnVerifiedParams(getSharedState.lastBlockNumber ?? 0)

            response.response = {
                notaryUrl,
                proxyUrl,
                publicKey,
                version: "0.1.0",
                ...(params ? { maxPresentationBytes: params.maxPresentationBytes } : {}),
            }
        } catch (error) {
            log.error("[manageNodeCall] tlsnotary.getInfo error: " + error)
            response.result = 500
            response.response = {
                success: false,
                error: "Failed to get TLSNotary info",
            }
        }
        return response
    },

    "tlsnotary.getToken": async (data, response) => {
        try {
            const { lookupToken } = await import(
                "@/features/tlsnotary/tokenManager"
            )

            const { tokenId, txHash } = data as {
                tokenId?: string
                txHash?: string
            }

            const id = tokenId || txHash
            if (typeof id !== "string" || !id) {
                response.result = 400
                response.response = {
                    error: "INVALID_REQUEST",
                    message: "Either tokenId or txHash is required",
                }
                return response
            }

            const token = await lookupToken(id)
            if (!token) {
                response.result = 404
                response.response = {
                    error: "TOKEN_NOT_FOUND",
                    message: "No token found for the provided identifier",
                }
            } else {
                response.response = { token }
            }
        } catch (error) {
            log.error("[manageNodeCall] tlsnotary.getToken error: " + error)
            response.result = 500
            response.response = {
                error: "INTERNAL_ERROR",
                message: "Failed to get token",
            }
        }
        return response
    },

    "tlsnotary.getTokenStats": async (_data, response) => {
        try {
            const { getTokenStats } = await import(
                "@/features/tlsnotary/tokenManager"
            )
            const stats = getTokenStats()
            response.response = { stats }
        } catch (error) {
            log.error(
                "[manageNodeCall] tlsnotary.getTokenStats error: " + error,
            )
            response.result = 500
            response.response = {
                error: "INTERNAL_ERROR",
                message: "Failed to get token stats",
            }
        }
        return response
    },
}