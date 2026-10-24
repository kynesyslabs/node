import { Middleware } from "../bunServer"

export interface BodyLimitOptions {
    /** Largest body an ordinary caller may send, in bytes. */
    maxBytes: number
    /** Largest body a trusted caller may send, in bytes. */
    peerMaxBytes: number
    /** Whether the request comes from a caller allowed the larger limit. */
    isPeer: (req: Request) => Promise<boolean> | boolean
}

const BODYLESS_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

function reject(status: number, error: string, limit?: number): Response {
    return new Response(
        JSON.stringify(limit === undefined ? { error } : { error, limit }),
        { status, headers: { "Content-Type": "application/json" } },
    )
}

/**
 * Refuses a request whose declared body is over the caller's limit before any
 * handler reads it, so an oversized JSON document is never buffered or parsed.
 *
 * The length has to be declared: a chunked body has no size to check up
 * front, and the server's own ceiling would then be the only bound. Every
 * client of this API (axios, fetch, the SDK) sends a Content-Length for a
 * JSON body, so a request without one is turned away instead of streamed.
 *
 * Trusted callers are looked up only when the body is over the ordinary
 * limit, so normal traffic never pays for the lookup.
 */
export function bodyLimit(options: BodyLimitOptions): Middleware {
    return async (req, next) => {
        if (BODYLESS_METHODS.has(req.method)) {
            return await next()
        }

        const declared = req.headers.get("content-length")
        if (declared === null) {
            // A request with no body has nothing to bound.
            if (req.body === null) {
                return await next()
            }
            return reject(411, "Content-Length required")
        }

        const length = Number(declared)
        if (!Number.isInteger(length) || length < 0) {
            return reject(400, "Invalid Content-Length")
        }
        if (length <= options.maxBytes) {
            return await next()
        }

        if (length <= options.peerMaxBytes && (await options.isPeer(req))) {
            return await next()
        }
        return reject(413, "Request body too large", options.maxBytes)
    }
}
