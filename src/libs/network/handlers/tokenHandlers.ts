import { scriptExecutor } from "@/libs/scripting"
import Datasource from "@/model/datasource"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { GCRToken } from "@/model/entities/GCRv2/GCR_Token"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"
import type { NodeCallHandler } from "./types"

function rejectCommittedReadIfStateInFlux(response: {
    result: number
    response: unknown
}): boolean {
    if (!getSharedState.inGcrApply) {
        return false
    }

    const maxMs = Number.parseInt(
        process.env.COMMITTED_READ_IN_FLUX_MAX_MS ?? "120000",
        10,
    )
    const since = getSharedState.inGcrApplySinceMs ?? 0
    const ageMs = since > 0 ? Date.now() - since : 0

    if (maxMs > 0 && ageMs > maxMs) {
        log.warn(
            `[tokenHandlers] inGcrApply stuck for ${ageMs}ms (> ${maxMs}ms). Refusing committed read until the writer clears state.`,
        )
    }

    response.result = 409
    response.response = {
        error: "STATE_IN_FLUX",
        message:
            "Committed state is currently being applied (sync/consensus). Retry shortly.",
    }
    return true
}

async function getRepo<T>(entity: any) {
    const db = await Datasource.getInstance()
    return db.getDataSource().getRepository<T>(entity)
}

const getTokenHandler: NodeCallHandler = async (data, response) => {
    if (!data?.tokenAddress) {
        response.result = 400
        response.response = {
            error: "INVALID_REQUEST",
            message: "tokenAddress is required",
        }
        return response
    }

    try {
        const gcrTokenRepository = await getRepo<GCRToken>(GCRToken)
        const token = await gcrTokenRepository.findOneBy({
            address: data.tokenAddress,
        })

        if (!token) {
            response.result = 404
            response.response = {
                error: "TOKEN_NOT_FOUND",
                message: `Token not found: ${data.tokenAddress}`,
            }
            return response
        }

        response.response = {
            tokenAddress: token.address,
            metadata: {
                name: token.name,
                ticker: token.ticker,
                decimals: token.decimals,
                deployer: token.deployer,
                deployerNonce: token.deployerNonce,
                deployedAt: token.deployedAt,
                hasScript: token.hasScript,
            },
            state: {
                totalSupply: token.totalSupply,
                balances: token.balances ?? {},
                allowances: token.allowances ?? {},
                customState: token.customState ?? {},
            },
            accessControl: {
                owner: token.owner,
                paused: token.paused,
                entries: token.aclEntries ?? [],
            },
        }
    } catch (error: any) {
        log.error("[tokenHandlers] token.get error: " + error)
        response.result = 500
        response.response = {
            error: "INTERNAL_ERROR",
            message: "Failed to fetch token",
            details: error.message || String(error),
        }
    }

    return response
}

const getTokenBalanceHandler: NodeCallHandler = async (data, response) => {
    if (!data?.tokenAddress || !data?.address) {
        response.result = 400
        response.response = {
            error: "INVALID_REQUEST",
            message: "tokenAddress and address are required",
        }
        return response
    }

    try {
        const gcrTokenRepository = await getRepo<GCRToken>(GCRToken)
        const token = await gcrTokenRepository.findOneBy({
            address: data.tokenAddress,
        })

        if (!token) {
            response.result = 404
            response.response = {
                error: "TOKEN_NOT_FOUND",
                message: `Token not found: ${data.tokenAddress}`,
            }
            return response
        }

        const balances: Record<string, string> = token.balances || {}
        response.response = {
            tokenAddress: data.tokenAddress,
            address: data.address,
            balance: balances[data.address] ?? "0",
        }
    } catch (error: any) {
        log.error("[tokenHandlers] token.getBalance error: " + error)
        response.result = 500
        response.response = {
            error: "INTERNAL_ERROR",
            message: "Failed to fetch token balance",
            details: error.message || String(error),
        }
    }

    return response
}

const getHolderPointersHandler: NodeCallHandler = async (data, response) => {
    if (!data?.address) {
        response.result = 400
        response.response = {
            error: "INVALID_REQUEST",
            message: "address is required",
        }
        return response
    }

    try {
        const gcrMainRepository = await getRepo<GCRMain>(GCRMain)
        const holder = await gcrMainRepository.findOneBy({
            pubkey: data.address,
        })

        response.response = {
            address: data.address,
            tokens: holder?.extended?.tokens ?? [],
        }
    } catch (error: any) {
        log.error("[tokenHandlers] token.getHolderPointers error: " + error)
        response.result = 500
        response.response = {
            error: "INTERNAL_ERROR",
            message: "Failed to fetch holder pointers",
            details: error.message || String(error),
        }
    }

    return response
}

const callViewHandler: NodeCallHandler = async (data, response) => {
    log.debug("[SERVER] Received token.callView")

    if (!data?.tokenAddress || !data?.method) {
        response.result = 400
        response.response = {
            error: "INVALID_REQUEST",
            message: "tokenAddress and method are required",
        }
        return response
    }

    try {
        const gcrTokenRepository = await getRepo<GCRToken>(GCRToken)
        const token = await gcrTokenRepository.findOneBy({
            address: data.tokenAddress,
        })

        if (!token) {
            response.result = 404
            response.response = {
                error: "TOKEN_NOT_FOUND",
                message: `Token not found: ${data.tokenAddress}`,
            }
            return response
        }

        if (!token.hasScript) {
            response.result = 400
            response.response = {
                error: "NO_SCRIPT",
                message: "Token does not have a script",
            }
            return response
        }

        const balances: Record<string, string> = token.balances || {}
        const allowances: Record<string, Record<string, string>> =
            token.allowances || {}

        const tokenData = {
            address: token.address,
            name: token.name,
            ticker: token.ticker,
            decimals: token.decimals,
            owner: token.owner,
            totalSupply: BigInt(token.totalSupply),
            balances: Object.fromEntries(
                Object.entries(balances).map(([key, value]) => [
                    key,
                    BigInt(value),
                ]),
            ),
            allowances: Object.fromEntries(
                Object.entries(allowances).map(([owner, spenders]) => [
                    owner,
                    Object.fromEntries(
                        Object.entries(spenders).map(([spender, value]) => [
                            spender,
                            BigInt(value),
                        ]),
                    ),
                ]),
            ),
            paused: token.paused,
            storage: token.customState,
        }

        const viewResult = await scriptExecutor.executeView({
            tokenAddress: data.tokenAddress,
            method: data.method,
            args: data.args ?? [],
            tokenData,
            scriptCode: token.script?.code ?? "",
        })

        if (!viewResult.success) {
            const errorResult = viewResult as Extract<
                typeof viewResult,
                { success: false }
            >
            response.result = 400
            response.response = {
                error:
                    errorResult.errorType?.toUpperCase() ??
                    "EXECUTION_ERROR",
                message: errorResult.error,
                gasUsed: errorResult.gasUsed,
                executionTimeMs: errorResult.executionTimeMs,
            }
            return response
        }

        response.response = {
            tokenAddress: data.tokenAddress,
            method: data.method,
            value: viewResult.value,
            executionTimeMs: viewResult.executionTimeMs,
            gasUsed: viewResult.gasUsed,
        }
    } catch (error: any) {
        log.error("[tokenHandlers] token.callView error: " + error)
        response.result = 500
        response.response = {
            error: "INTERNAL_ERROR",
            message: "Failed to execute view function",
            details: error.message || String(error),
        }
    }

    return response
}

export const tokenHandlers: Record<string, NodeCallHandler> = {
    "token.get": getTokenHandler,
    "token.getCommitted": async (data, response) => {
        if (rejectCommittedReadIfStateInFlux(response)) {
            return response
        }
        return getTokenHandler(data, response)
    },
    "token.getBalance": getTokenBalanceHandler,
    "token.getBalanceCommitted": async (data, response) => {
        if (rejectCommittedReadIfStateInFlux(response)) {
            return response
        }
        return getTokenBalanceHandler(data, response)
    },
    "token.getHolderPointers": getHolderPointersHandler,
    "token.callView": callViewHandler,
    "token.callViewCommitted": async (data, response) => {
        if (rejectCommittedReadIfStateInFlux(response)) {
            return response
        }
        return callViewHandler(data, response)
    },
}
