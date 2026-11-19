import { Connection } from "@solana/web3.js"
import { Config } from "src/config"
import log from "src/utilities/logger"

/**
 * Solana reads for validator gating, asked of every configured endpoint at
 * once: SOLANA_RPC and Helius when set, then the VALIDATOR_SOLANA_RPCS list,
 * or the free public endpoints below when that list is empty. No key is
 * required: a node with none still reads from the public endpoints.
 */

export const PUBLIC_SOLANA_RPC = "https://api.mainnet-beta.solana.com"

/** Free endpoints that need no key, used when VALIDATOR_SOLANA_RPCS is empty. */
export const DEFAULT_PUBLIC_SOLANA_RPCS: readonly string[] = [
    PUBLIC_SOLANA_RPC,
    "https://solana-rpc.publicnode.com",
]

/** Per-endpoint timeout for one Solana read. */
export const SOLANA_RPC_TIMEOUT_MS = 5000

/** A read that could not be answered by any endpoint. */
export class SolanaUnreachableError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "SolanaUnreachableError"
    }
}

function splitList(raw: string): string[] {
    return raw
        .split(",")
        .map(url => url.trim())
        .filter(url => url !== "")
}

/** The endpoints to ask, without duplicates. */
export function resolveSolanaEndpoints(): string[] {
    const identity = Config.getInstance().identity
    const configured = splitList(identity.validatorSolanaRpcs ?? "")
    const candidates = [
        ...splitList(identity.solanaRpc ?? ""),
        ...(identity.heliusApiKey?.trim()
            ? [`https://mainnet.helius-rpc.com/?api-key=${identity.heliusApiKey.trim()}`]
            : []),
        ...(configured.length > 0 ? configured : DEFAULT_PUBLIC_SOLANA_RPCS),
    ]
    return [...new Set(candidates)]
}

/** An endpoint with its key hidden, for logs. */
function describeEndpoint(url: string): string {
    try {
        const parsed = new URL(url)
        return parsed.host
    } catch {
        return "invalid-url"
    }
}

const connections = new Map<string, Connection>()

function connectionFor(url: string): Connection {
    let connection = connections.get(url)
    if (connection === undefined) {
        connection = new Connection(url, { commitment: "finalized" })
        connections.set(url, connection)
    }
    return connection
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`${what} timed out after ${ms}ms`)),
            ms,
        )
        promise.then(
            value => {
                clearTimeout(timer)
                resolve(value)
            },
            error => {
                clearTimeout(timer)
                reject(error)
            },
        )
    })
}

/**
 * Run `read` against every endpoint at once and take the first answer, so a
 * read costs one timeout however many endpoints hang. An error or timeout at
 * one endpoint is ignored while another answers; when all fail the read is
 * unreachable.
 */
export async function withSolana<T>(
    what: string,
    read: (connection: Connection) => Promise<T>,
): Promise<T> {
    const attempts = resolveSolanaEndpoints().map(url =>
        withTimeout(read(connectionFor(url)), SOLANA_RPC_TIMEOUT_MS, what).catch((e: unknown) => {
            const message = describeError(e)
            log.warning(`[SOLANA] ${what} failed at ${describeEndpoint(url)}: ${message}`)
            throw new Error(`${describeEndpoint(url)}: ${message}`)
        }),
    )
    try {
        return await Promise.any(attempts)
    } catch (e) {
        const failures =
            e instanceof AggregateError ? e.errors.map(describeError) : [describeError(e)]
        throw new SolanaUnreachableError(`${what}: ${failures.join("; ")}`)
    }
}

/** One `getSlot` per endpoint, all at once, for the boot report. */
export async function probeSolanaEndpoints(): Promise<{ url: string; ok: boolean }[]> {
    return Promise.all(
        resolveSolanaEndpoints().map(async url => {
            try {
                await withTimeout(
                    connectionFor(url).getSlot("finalized"),
                    SOLANA_RPC_TIMEOUT_MS,
                    "getSlot",
                )
                return { url: describeEndpoint(url), ok: true }
            } catch {
                return { url: describeEndpoint(url), ok: false }
            }
        }),
    )
}

function describeError(e: unknown): string {
    if (e instanceof Error) return e.message
    return typeof e === "string" ? e : JSON.stringify(e)
}

/** Drop cached connections, for tests. */
export function resetSolanaConnectionsForTesting(): void {
    connections.clear()
}
