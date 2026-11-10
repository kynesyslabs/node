import { Connection } from "@solana/web3.js"
import { Config } from "src/config"
import log from "src/utilities/logger"

/**
 * Solana reads for validator gating, tried against each configured endpoint
 * in turn: the SOLANA_RPC list, then Helius when a key is set, then the
 * public mainnet endpoint.
 */

export const PUBLIC_SOLANA_RPC = "https://api.mainnet-beta.solana.com"

/** Per-endpoint timeout for one Solana read. */
export const SOLANA_RPC_TIMEOUT_MS = 5000

/** A read that could not be answered by any endpoint. */
export class SolanaUnreachableError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "SolanaUnreachableError"
    }
}

/** The endpoints to try, in order, without duplicates. */
export function resolveSolanaEndpoints(): string[] {
    const identity = Config.getInstance().identity
    const out: string[] = []
    for (const url of identity.solanaRpc.split(",")) {
        const trimmed = url.trim()
        if (trimmed !== "" && !out.includes(trimmed)) out.push(trimmed)
    }
    if (identity.heliusApiKey !== "") {
        const helius = `https://mainnet.helius-rpc.com/?api-key=${identity.heliusApiKey}`
        if (!out.includes(helius)) out.push(helius)
    }
    if (!out.includes(PUBLIC_SOLANA_RPC)) out.push(PUBLIC_SOLANA_RPC)
    return out
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
 * Run `read` against each endpoint until one answers. A thrown error or a
 * timeout moves to the next endpoint; when all fail the read is unreachable.
 */
export async function withSolana<T>(
    what: string,
    read: (connection: Connection) => Promise<T>,
): Promise<T> {
    const timeoutMs = SOLANA_RPC_TIMEOUT_MS
    const failures: string[] = []
    for (const url of resolveSolanaEndpoints()) {
        try {
            return await withTimeout(read(connectionFor(url)), timeoutMs, what)
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e)
            failures.push(`${describeEndpoint(url)}: ${message}`)
            log.warning(`[SOLANA] ${what} failed at ${describeEndpoint(url)}: ${message}`)
        }
    }
    throw new SolanaUnreachableError(`${what}: ${failures.join("; ")}`)
}

/** One `getSlot` per endpoint, for the boot check. */
export async function probeSolanaEndpoints(): Promise<{ url: string; ok: boolean }[]> {
    const timeoutMs = SOLANA_RPC_TIMEOUT_MS
    const results: { url: string; ok: boolean }[] = []
    for (const url of resolveSolanaEndpoints()) {
        try {
            await withTimeout(connectionFor(url).getSlot("finalized"), timeoutMs, "getSlot")
            results.push({ url: describeEndpoint(url), ok: true })
        } catch {
            results.push({ url: describeEndpoint(url), ok: false })
        }
    }
    return results
}

/** Drop cached connections, for tests. */
export function resetSolanaConnectionsForTesting(): void {
    connections.clear()
}
