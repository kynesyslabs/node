import type { IOperation } from "@kynesyslabs/demosdk/types"
import { EVM } from "@kynesyslabs/demosdk/xm-localsdk"
import { evmProviders } from "sdk/localsdk/multichain/configs/evmProviders"
import { Config } from "src/config"
import log from "@/utilities/logger"
import { resolvePublicAddress } from "src/utilities/outboundAddress"

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
 * origin) and the host resolves to public addresses only. Honouring any caller
 * URL would let a caller make the node fetch arbitrary addresses, including
 * the operator's private network; a listed name can later be pointed there,
 * so it is resolved on every use. The chain SDK client resolves the name
 * again when it connects, so this does not pin the address it dials.
 */
export async function pickRpcUrl(
    callerUrl: unknown,
    configuredUrl: string | undefined,
    allowlist: readonly string[] = Config.getInstance().outbound.xmRpcAllowlist,
    resolveHost: (host: string) => Promise<unknown> = resolvePublicAddress,
): Promise<string | undefined> {
    if (typeof callerUrl !== "string" || callerUrl === "") return configuredUrl

    let parsed: URL
    try {
        parsed = new URL(callerUrl)
    } catch {
        return configuredUrl
    }
    if (!RPC_SCHEMES.has(parsed.protocol) || !isListed(parsed, allowlist)) {
        log.debug(
            `[XM] Ignoring caller RPC URL for host ${parsed.hostname}: not in XM_RPC_ALLOWLIST`,
        )
        return configuredUrl
    }
    try {
        await resolveHost(parsed.hostname)
    } catch (e) {
        log.warning(
            `[XM] Ignoring allow-listed RPC host ${parsed.hostname}: ${
                e instanceof Error ? e.message : String(e)
            }`,
        )
        return configuredUrl
    }
    return callerUrl
}

/**
 * The node's configured EVM RPC URL for a chain, read from the configured keys
 * only: names such as "constructor" or "toString" are inherited from
 * Object.prototype, not configured.
 */
export function configuredEvmUrl(
    chain: unknown,
    subchain: unknown,
): string | undefined {
    if (typeof chain !== "string" || typeof subchain !== "string") {
        return undefined
    }
    if (!Object.hasOwn(evmProviders, chain)) return undefined
    const urls: Record<string, unknown> = evmProviders[chain]
    if (!Object.hasOwn(urls, subchain)) return undefined
    const url = urls[subchain]
    return typeof url === "string" && url !== "" ? url : undefined
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
    const configuredUrl = configuredEvmUrl(operation.chain, operation.subchain)
    const rpcUrl = await pickRpcUrl(operation.rpc, configuredUrl)
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

    const evmInstance = await cachedEvmInstance(chainID, rpcUrl)
    return await evmInstance.sendSignedTransaction(
        operation.task.signedPayloads[0],
    )
}

/** The SDK's cached instance for `chainID`, created on `configuredUrl` if absent. */
async function cachedEvmInstance(chainID: number, configuredUrl: string) {
    let evmInstance = EVM.getInstance(chainID)
    if (!evmInstance) {
        evmInstance = EVM.createInstance(chainID, configuredUrl)
        await evmInstance.connect()
    }
    return evmInstance
}

/**
 * The cached EVM instance for an operation's configured chain, or null when
 * the node has no RPC configured for it. Nothing is created or cached for an
 * unconfigured chain: a cached instance without a URL would also break every
 * later operation on that chain id.
 */
export async function configuredEvmInstance(
    operation: IOperation,
    chainID: number,
) {
    const configuredUrl = configuredEvmUrl(operation.chain, operation.subchain)
    if (!configuredUrl) return null
    return await cachedEvmInstance(chainID, configuredUrl)
}
