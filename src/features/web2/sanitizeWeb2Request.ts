import { IWeb2Payload, IWeb2Request } from "@kynesyslabs/demosdk/types"

const SENSITIVE_HEADER_KEYS = new Set([
    "authorization",
    "proxy-authorization",
    "x-api-key",
    "api-key",
    "x-auth-token",
    "x-access-token",
    "x-authorization",
    "x-session-token",
    "cookie",
    "set-cookie",
])

const REDACTED_VALUE = "[redacted]"

type Web2Headers = NonNullable<IWeb2Request["raw"]["headers"]>

export function stripSensitiveWeb2Headers(
    headers?: IWeb2Request["raw"]["headers"],
): IWeb2Request["raw"]["headers"] {
    if (!headers) {
        return headers
    }

    const sanitized: Partial<Web2Headers> = {}

    for (const [key, value] of Object.entries(headers)) {
        if (SENSITIVE_HEADER_KEYS.has(key.toLowerCase())) {
            continue
        }

        sanitized[key] = value
    }

    return Object.keys(sanitized).length > 0 ? sanitized : undefined
}

function sensitiveKeys(headers: unknown): string[] {
    if (!headers || typeof headers !== "object") return []
    return Object.keys(headers).filter(k =>
        SENSITIVE_HEADER_KEYS.has(k.toLowerCase()),
    )
}

/**
 * Credential fields a signed `web2Request` tx would publish on chain. The tx
 * is stored as signed, so the node cannot strip them; it can only refuse it.
 */
export function credentialFieldsInWeb2Payload(payload: unknown): string[] {
    const message = (payload as IWeb2Payload | undefined)?.message
    if (!message || typeof message !== "object") return []
    const found: string[] = []
    if (message.authorization) found.push("authorization")
    const request = message.web2Request
    for (const key of sensitiveKeys(request?.raw?.headers)) {
        found.push(`request header ${key}`)
    }
    for (const key of sensitiveKeys(
        (request?.result as { headers?: unknown } | undefined)?.headers,
    )) {
        found.push(`result header ${key}`)
    }
    return found
}

/**
 * Credential headers in the web2 steps of a signed `demoswork` tx: the script
 * is stored on chain as signed too, so these are refused like a web2Request's.
 */
export function credentialFieldsInDemoScript(script: unknown): string[] {
    const steps = (script as { steps?: unknown } | undefined)?.steps
    if (!steps || typeof steps !== "object") return []
    const found: string[] = []
    for (const [id, step] of Object.entries(steps)) {
        const { context, content } = (step ?? {}) as {
            context?: unknown
            content?: IWeb2Request
        }
        if (context !== "web2") continue
        // The id is the caller's; keep the echo short.
        const label = `step ${id.slice(0, 64)}`
        for (const key of sensitiveKeys(content?.raw?.headers)) {
            found.push(`${label} request header ${key}`)
        }
        for (const key of sensitiveKeys(
            (content?.result as { headers?: unknown } | undefined)?.headers,
        )) {
            found.push(`${label} result header ${key}`)
        }
    }
    return found
}

/** Request headers the broadcast-time replay may forward (lowercase). */
const REPLAY_HEADER_ALLOW_LIST = new Set([
    "accept",
    "accept-charset",
    "accept-encoding",
    "accept-language",
    "cache-control",
    "content-language",
    "content-type",
    "idempotency-key",
    "if-match",
    "if-modified-since",
    "if-none-match",
    "if-range",
    "if-unmodified-since",
    "pragma",
    "range",
    "user-agent",
])

/**
 * Headers for the broadcast-time replay of a signed `web2Request` tx. Only
 * the allow-listed headers are kept, in any casing; every other header was
 * meant for the attested RPC call alone. Always returns an object: the proxy
 * iterates the map and would throw on `undefined`.
 */
export function headersForReplay(
    headers?: IWeb2Request["raw"]["headers"],
): Web2Headers {
    const kept: Partial<Web2Headers> = {}
    for (const [key, value] of Object.entries(headers ?? {})) {
        if (REPLAY_HEADER_ALLOW_LIST.has(key.toLowerCase())) {
            kept[key] = value
        }
    }
    return kept as Web2Headers
}

export function redactSensitiveWeb2Headers(
    headers?: IWeb2Request["raw"]["headers"],
): IWeb2Request["raw"]["headers"] {
    if (!headers) {
        return headers
    }

    const sanitized: Partial<Web2Headers> = {}

    for (const [key, value] of Object.entries(headers)) {
        if (SENSITIVE_HEADER_KEYS.has(key.toLowerCase())) {
            sanitized[key] = Array.isArray(value)
                ? value.map(() => REDACTED_VALUE)
                : REDACTED_VALUE

            continue
        }

        sanitized[key] = value
    }

    return sanitized
}

export function sanitizeWeb2RequestForStorage(
    web2Request: IWeb2Request,
): IWeb2Request {
    if (!web2Request) {
        return web2Request
    }

    const raw = web2Request.raw

    return {
        ...web2Request,
        raw: raw
            ? {
                  ...raw,
                  headers: stripSensitiveWeb2Headers(raw.headers),
              }
            : raw,
    }
}

export function sanitizeWeb2RequestForLogging(
    web2Request: IWeb2Request,
): IWeb2Request {
    if (!web2Request) {
        return web2Request
    }

    const raw = web2Request.raw

    return {
        ...web2Request,
        raw: raw
            ? {
                  ...raw,
                  headers: redactSensitiveWeb2Headers(raw.headers),
              }
            : raw,
    }
}
