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

/**
 * Thrown by a read when its endpoint answered but holds no such record (an
 * unknown signature). Unlike a transport failure it is an answer, so the
 * shared result cache keeps it for the round.
 */
export class SolanaAbsentError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "SolanaAbsentError"
    }
}

/** Every endpoint answered and none holds the record. Still unreachable to callers. */
export class SolanaNotFoundError extends SolanaUnreachableError {
    constructor(message: string) {
        super(message)
        this.name = "SolanaNotFoundError"
    }
}

/**
 * Seat transactions are free and peers relay them, so whatever they name,
 * this node runs at most this many Solana reads at once (each asks every
 * endpoint) and queues at most SOLANA_MAX_QUEUED_READS more. A read past the
 * queue, or one queued longer than SOLANA_RPC_TIMEOUT_MS, is unreachable at
 * once rather than waiting: public endpoints rate-limit, and a flood must not
 * turn honest reads into a backlog every merge waits on.
 */
export const SOLANA_MAX_CONCURRENT_READS = 8
export const SOLANA_MAX_QUEUED_READS = 32

let activeReads = 0
const queuedReads: Array<() => void> = []
// Bumped by the test reset, so a read started before it does not free a slot after.
let limiterGeneration = 0

function releaseRead(): void {
    activeReads--
    const next = queuedReads.shift()
    if (next !== undefined) next()
}

function slotRelease(): () => void {
    let released = false
    const generation = limiterGeneration
    return () => {
        if (released || generation !== limiterGeneration) return
        released = true
        releaseRead()
    }
}

/** A slot now, or null when every slot is taken. */
function takeFreeSlot(): (() => void) | null {
    if (activeReads >= SOLANA_MAX_CONCURRENT_READS) return null
    activeReads++
    return slotRelease()
}

function waitForSlot(what: string): Promise<() => void> {
    if (queuedReads.length >= SOLANA_MAX_QUEUED_READS) {
        return Promise.reject(
            new SolanaUnreachableError(
                `${what}: Solana read limit reached (${activeReads} running, ${queuedReads.length} queued)`,
            ),
        )
    }
    return new Promise<() => void>((resolve, reject) => {
        const grant = () => {
            clearTimeout(timer)
            activeReads++
            resolve(slotRelease())
        }
        const timer = setTimeout(() => {
            const at = queuedReads.indexOf(grant)
            if (at !== -1) queuedReads.splice(at, 1)
            reject(
                new SolanaUnreachableError(
                    `${what}: no Solana read slot within ${SOLANA_RPC_TIMEOUT_MS}ms`,
                ),
            )
        }, SOLANA_RPC_TIMEOUT_MS)
        queuedReads.push(grant)
    })
}

async function limited<T>(what: string, read: () => Promise<T>): Promise<T> {
    // A free slot is taken synchronously, so the read starts in this tick.
    const release = takeFreeSlot() ?? (await waitForSlot(what))
    try {
        return await read()
    } finally {
        release()
    }
}

/**
 * How long an answer, or an answer that the record does not exist, is
 * shared by every read of the same key: about one consensus round, so the
 * admission check, the merge and the own-pool re-judge of one tx cost one
 * read, and a made-up signature relayed by every peer costs one per round.
 * Fresh reads use it too: they skip the outage mark, not this.
 */
export const SOLANA_SHARED_RESULT_MS = 5_000
export const SOLANA_SHARED_RESULT_CAP = 2_000

type Shared = { until: number; value?: unknown; error?: SolanaNotFoundError }
const sharedResults = new Map<string, Shared>()
const inFlight = new Map<string, Promise<unknown>>()

function share(key: string, entry: Shared): void {
    sharedResults.delete(key)
    if (sharedResults.size >= SOLANA_SHARED_RESULT_CAP) {
        const oldest = sharedResults.keys().next()
        if (!oldest.done) sharedResults.delete(oldest.value)
    }
    sharedResults.set(key, entry)
}

/**
 * `read` once for every caller asking `key` while it runs, and its answer
 * (or its not-found) for SOLANA_SHARED_RESULT_MS after. A transport failure
 * is not shared past the read itself. Callers must not mutate the value.
 */
export async function sharedSolanaRead<T>(key: string, read: () => Promise<T>): Promise<T> {
    const cached = sharedResults.get(key)
    if (cached !== undefined) {
        if (cached.until > Date.now()) {
            if (cached.error !== undefined) throw cached.error
            return cached.value as T
        }
        sharedResults.delete(key)
    }
    const running = inFlight.get(key)
    if (running !== undefined) return running as Promise<T>
    const started = read().then(
        value => {
            share(key, { until: Date.now() + SOLANA_SHARED_RESULT_MS, value })
            return value
        },
        (e: unknown) => {
            if (e instanceof SolanaNotFoundError) {
                share(key, { until: Date.now() + SOLANA_SHARED_RESULT_MS, error: e })
            }
            throw e
        },
    )
    inFlight.set(key, started)
    try {
        return await started
    } finally {
        inFlight.delete(key)
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
    return limited(what, async () => {
        const attempts = resolveSolanaEndpoints().map(url =>
            withTimeout(read(connectionFor(url)), SOLANA_RPC_TIMEOUT_MS, what).catch((e: unknown) => {
                const message = `${describeEndpoint(url)}: ${describeError(e)}`
                log.warning(`[SOLANA] ${what} failed at ${message}`)
                throw e instanceof SolanaAbsentError ? new SolanaAbsentError(message) : new Error(message)
            }),
        )
        try {
            return await Promise.any(attempts)
        } catch (e) {
            const errors = e instanceof AggregateError ? e.errors : [e]
            const text = `${what}: ${errors.map(describeError).join("; ")}`
            throw errors.length > 0 && errors.every(err => err instanceof SolanaAbsentError)
                ? new SolanaNotFoundError(text)
                : new SolanaUnreachableError(text)
        }
    })
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

/** Drop cached connections, shared results and the read limiter's state, for tests. */
export function resetSolanaConnectionsForTesting(): void {
    connections.clear()
    sharedResults.clear()
    inFlight.clear()
    activeReads = 0
    queuedReads.length = 0
    limiterGeneration++
}

/** Reads running and queued now, for tests. */
export function solanaReadLoadForTesting(): { running: number; queued: number } {
    return { running: activeReads, queued: queuedReads.length }
}
