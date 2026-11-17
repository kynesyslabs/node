/**
 * The RPC reply to an identity transaction. Kept apart from
 * handleIdentityRequest so tests that replace that handler keep this.
 */

export interface IdentityResponse {
    success: boolean
    message: string
    /** Set when the refusal says nothing about the tx, so a client may resend it. */
    retryable?: boolean
}

/** The `extra` of the RPC reply to an identity transaction. */
export function identityReplyExtra(result: IdentityResponse): { message: string; retryable?: true } {
    const status = result.success ? "applied" : "not applied"
    return {
        message: result.message + `. Transaction ${status}.`,
        ...(result.retryable === true ? { retryable: true as const } : {}),
    }
}
