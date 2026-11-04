// Startup message for a Postgres connection that cannot be made. The driver's
// own error ("getaddrinfo ENOTFOUND") names neither the host nor the database,
// so an operator whose Postgres service is absent cannot tell what the node
// tried to reach. Pure function: no imports, no side effects. The password is
// not a parameter, so it cannot end up in the message.

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
    const unreachable = UNREACHABLE_CODES.some(
        c => code === c || reason.includes(c),
    ) || UNREACHABLE_MESSAGES.some(m => reason.toLowerCase().includes(m))
    const hint = unreachable
        ? " The Postgres service is absent or unreachable: check that it is running and that PG_HOST / PG_PORT point at it."
        : ""
    return (
        `[DB] Postgres startup failed for ${target.host}:${target.port} ` +
        `(database "${target.database}"): ${reason}.${hint}`
    )
}
