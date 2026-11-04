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

export function describeDbConnectionFailure(
    target: DbTarget,
    error: unknown,
): string {
    const reason = error instanceof Error ? error.message : String(error)
    const code = (error as { code?: unknown } | null)?.code
    const unreachable = UNREACHABLE_CODES.some(
        c => code === c || reason.includes(c),
    )
    const hint = unreachable
        ? " The Postgres service is absent or unreachable: check that it is running and that PG_HOST / PG_PORT point at it."
        : ""
    return (
        `[DB] Postgres startup failed for ${target.host}:${target.port} ` +
        `(database "${target.database}"): ${reason}.${hint}`
    )
}
