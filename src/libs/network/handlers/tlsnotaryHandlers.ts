import { Config } from "src/config"
import log from "src/utilities/logger"
import type { NodeCallHandler } from "./types"
import { tlsnVerifiedParams } from "@/forks/tlsnVerifiedGate"
import { getSharedState } from "@/utilities/sharedState"

/**
 * The presentation size cap the chain enforces at the tip, so a client can
 * refuse an oversized proof before paying for it; undefined before the
 * tlsnVerified fork, when the chain has none.
 */
export function chainMaxPresentationBytes(): number | undefined {
    try {
        return tlsnVerifiedParams(getSharedState.lastBlockNumber ?? 0)?.maxPresentationBytes
    } catch {
        return undefined
    }
}

function proxyStatus(body: any): number {
    return typeof body?.status === "number" ? body.status : 200
}

export const tlsnotaryHandlers: Record<string, NodeCallHandler> = {
    requestTLSNproxy: async (data, response, sender, clientIP) => {
        const { requestTlsnProxy } = await import("@/features/tlsnotary/proxyRequest")
        response.response = await requestTlsnProxy(data ?? {}, sender, clientIP)
        response.result = proxyStatus(response.response)
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

            const maxPresentationBytes = chainMaxPresentationBytes()
            response.response = {
                notaryUrl,
                proxyUrl,
                publicKey,
                version: "0.1.0",
                ...(maxPresentationBytes === undefined ? {} : { maxPresentationBytes }),
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