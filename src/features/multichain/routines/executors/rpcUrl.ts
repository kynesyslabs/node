import type { IOperation } from "@kynesyslabs/demosdk/types"
import { EVM } from "@kynesyslabs/demosdk/xm-localsdk"
import { evmProviders } from "sdk/localsdk/multichain/configs/evmProviders"
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

/**
 * Broadcasts an XM operation's signed EVM transaction. The SDK caches one
 * instance per chain id, so only the configured RPC goes into that cache: an
 * allow-listed caller URL gets a connection of its own, which later callers
 * on the same chain never inherit.
 */
export async function sendSignedEvmTransaction(
    operation: IOperation,
    chainID: number,
) {
    const configuredUrl = evmProviders[operation.chain]?.[operation.subchain]
    const rpcUrl = pickRpcUrl(operation.rpc, configuredUrl)
    if (!rpcUrl) {
        return {
            result: "error",
            error: `RPC URL not found for ${operation.chain}.${operation.subchain}`,
        }
    }

    if (rpcUrl !== configuredUrl) {
        const own = new EVM(rpcUrl, chainID)
        try {
            await own.connect()
            return await own.sendSignedTransaction(
                operation.task.signedPayloads[0],
            )
        } finally {
            own.provider?.destroy?.()
        }
    }

    let evmInstance = EVM.getInstance(chainID)
    if (!evmInstance) {
        evmInstance = EVM.createInstance(chainID, rpcUrl)
        await evmInstance.connect()
    }
    return await evmInstance.sendSignedTransaction(
        operation.task.signedPayloads[0],
    )
}
