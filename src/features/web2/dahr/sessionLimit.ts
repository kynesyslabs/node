/**
 * Longest URL a web2 session takes, in characters: the create request's URL
 * as sent, and a start's URL once normalized.
 */
export const SESSION_URL_MAX_CHARS = 4096

/**
 * Raised when a web2 create finds this node already holding
 * WEB2_MAX_SESSIONS_TOTAL sessions. The RPC answers it with 429 and the body
 * of a refused fetch, so a client handles both the same way.
 *
 * Kept out of DAHRFactory so code that replaces that module can still tell
 * this refusal apart from a fault.
 */
export class Web2SessionLimitError extends Error {
    readonly reason = "node-sessions"

    constructor(
        readonly limit: number,
        readonly retryAfterSeconds: number,
    ) {
        super(
            `web2 session refused: this node holds its maximum of ${limit} ` +
                `web2 sessions. Retry after ${retryAfterSeconds} s.`,
        )
        this.name = "Web2SessionLimitError"
    }
}
