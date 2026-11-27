export const WEB2_SESSIONS_LIMITED = "WEB2_SESSIONS_LIMITED"

/** Thrown when a new session would pass a per-caller or node-wide cap. */
export class DAHRSessionLimitError extends Error {
    constructor(
        readonly reason: "caller-sessions" | "node-sessions",
        message: string,
    ) {
        super(message)
        this.name = "DAHRSessionLimitError"
    }
}
