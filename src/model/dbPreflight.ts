// Startup message for a Postgres connection that cannot be made. The driver's
// own error ("getaddrinfo ENOTFOUND") names neither the host nor the database,
// so an operator whose Postgres service is absent cannot tell what the node
// tried to reach. Also the bounded retry for a Postgres that starts a few
// seconds after the node. No imports. The password is not a parameter, so it
// cannot end up in a message.

export interface DbTarget {
    host: string
    port: number
    database: string
}

// Network-level failures: the server was never reached. initialize() also runs
// migrations, so other errors must not be called "unreachable".
const UNREACHABLE_CODES = [
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EHOSTUNREACH",
    "ENETUNREACH",
]

// pg and pg-pool raise their own connect timeouts with no `code`.
const UNREACHABLE_MESSAGES = [
    "connection timeout",
    "timeout exceeded when trying to connect",
    "timeout expired",
]

function isUnreachable(error: unknown): boolean {
    const code = (error as { code?: unknown } | null)?.code
    const reason =
        (error instanceof Error && error.message) || (code ? String(code) : String(error))
    return (
        UNREACHABLE_CODES.some(c => code === c || reason.includes(c)) ||
        UNREACHABLE_MESSAGES.some(m => reason.toLowerCase().includes(m))
    )
}

/**
 * True for a failure that a Postgres starting next to the node produces for a
 * few seconds: not reachable yet, or reachable and still recovering (57P03).
 * A wrong password or a missing database stays wrong, so it is not retried.
 */
export function isDbStartupRace(error: unknown): boolean {
    const code = (error as { code?: unknown } | null)?.code
    const message = error instanceof Error ? error.message.toLowerCase() : ""
    return (
        isUnreachable(error) ||
        code === "57P03" ||
        message.includes("the database system is starting up")
    )
}

export interface ConnectRetryOptions {
    /** Tries in all, the first included. */
    attempts: number
    baseDelayMs: number
    maxDelayMs: number
    sleep?: (ms: number) => Promise<void>
    onRetry?: (attempt: number, delayMs: number, error: unknown) => void
}

/**
 * Runs `connect` until it succeeds, retrying a startup race with exponential
 * backoff up to `attempts` tries. Any other error, and the last one, is thrown
 * as raised.
 */
export async function connectWithRetry<T>(
    connect: () => Promise<T>,
    options: ConnectRetryOptions,
): Promise<T> {
    const sleep =
        options.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
    for (let attempt = 1; ; attempt++) {
        try {
            return await connect()
        } catch (error) {
            if (attempt >= options.attempts || !isDbStartupRace(error)) throw error
            const delayMs = Math.min(
                options.maxDelayMs,
                options.baseDelayMs * 2 ** (attempt - 1),
            )
            options.onRetry?.(attempt, delayMs, error)
            await sleep(delayMs)
        }
    }
}

export function describeDbConnectionFailure(
    target: DbTarget,
    error: unknown,
): string {
    const code = (error as { code?: unknown } | null)?.code
    // Some driver errors (an AggregateError from a dual-stack connect) have an
    // empty message; fall back to the error code so the line is never ": .".
    const reason =
        (error instanceof Error && error.message) ||
        (code ? String(code) : String(error))
    const unreachable = isUnreachable(error)
    const hint = unreachable
        ? " The Postgres service is absent or unreachable: check that it is running and that PG_HOST / PG_PORT point at it."
        : ""
    return (
        `[DB] Postgres startup failed for ${target.host}:${target.port} ` +
        `(database "${target.database}"): ${reason}.${hint}`
    )
}
