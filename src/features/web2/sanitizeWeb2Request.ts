import { IWeb2Request } from "@kynesyslabs/demosdk/types"

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
