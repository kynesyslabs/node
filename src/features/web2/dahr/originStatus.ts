import { IWeb2Request } from "@kynesyslabs/demosdk/types"

/**
 * Name of the `web2Request.raw.parameters` entry that lets a caller attest a
 * non-2xx origin response. It lives in `raw.parameters` because that list is
 * copied into the signed web2Request tx, so the opt-in is part of what gets
 * attested and the node replays the request under the same rule.
 */
export const ALLOW_NON_SUCCESS_STATUS_PARAM = "allowNonSuccessStatus"

/**
 * Header the DAHR proxy puts on responses it generates itself (auth, SSRF and
 * upstream failures), so they are never mistaken for an origin response.
 */
export const DAHR_PROXY_ERROR_HEADER = "x-dahr-proxy-error"

export type UnattestableReason = "origin-non-2xx" | "proxy-error"

/**
 * Raised when DAHR refuses to return a response for attestation.
 * `rpcStatus` is the result code the RPC layer answers with.
 */
export class UnattestableResponseError extends Error {
    constructor(
        message: string,
        readonly reason: UnattestableReason,
        readonly rpcStatus: number,
        readonly originStatus: number | null = null,
    ) {
        super(message)
        this.name = "UnattestableResponseError"
    }
}

export function isSuccessStatus(status: number): boolean {
    return Number.isInteger(status) && status >= 200 && status <= 299
}

/**
 * Only a literal boolean `true` opts in, so a malformed or stringly-typed
 * parameter falls back to the safe default.
 */
export function allowsNonSuccessStatus(
    raw: Pick<IWeb2Request["raw"], "parameters"> | undefined,
): boolean {
    const parameters = raw?.parameters
    if (!Array.isArray(parameters)) return false
    return parameters.some(
        p =>
            p != null &&
            p.name === ALLOW_NON_SUCCESS_STATUS_PARAM &&
            p.value === true,
    )
}
