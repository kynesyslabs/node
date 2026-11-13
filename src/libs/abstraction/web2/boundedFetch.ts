import { Config } from "src/config"

/**
 * Wall-clock limit for one web2 request, body included: the same limit the
 * web2 proxy applies. A socket idle timeout alone never fires while the
 * origin keeps trickling bytes.
 */
export const WEB2_REQUEST_TIMEOUT_MS = 30_000

export interface Web2Limits {
    timeoutMs: number
    maxBytes: number
}

/** The limits the web2 proxy applies to an origin response. */
export function web2Limits(): Web2Limits {
    return {
        timeoutMs: WEB2_REQUEST_TIMEOUT_MS,
        maxBytes: Config.getInstance().outbound.web2MaxResponseBytes,
    }
}

// The Fetch spec forbids a body on these statuses.
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304])

async function readCapped(
    body: AsyncIterable<Uint8Array> | null,
    maxBytes: number,
): Promise<Uint8Array> {
    if (!body) return new Uint8Array(0)
    const chunks: Uint8Array[] = []
    let received = 0
    // Leaving the loop early cancels the stream.
    for await (const chunk of body) {
        received += chunk.byteLength
        if (received > maxBytes) {
            throw new Error(`Web2 response exceeds ${maxBytes} bytes`)
        }
        chunks.push(chunk)
    }
    const out = new Uint8Array(received)
    let offset = 0
    for (const chunk of chunks) {
        out.set(chunk, offset)
        offset += chunk.byteLength
    }
    return out
}

// A dependency replaces globalThis.fetch with node-fetch at import time;
// Bun's own fetch is the one whose abort reaches a body already streaming.
const runtimeFetch = (): typeof fetch =>
    typeof Bun !== "undefined" && typeof Bun.fetch === "function"
        ? (Bun.fetch as typeof fetch)
        : globalThis.fetch

/**
 * A `fetch` that gives up once the whole exchange, body included, has taken
 * `timeoutMs`, and refuses a body larger than `maxBytes` without holding more
 * than that in memory. The body is read before the response is returned, so
 * the caller's own reads cannot outlive the deadline.
 */
export function boundedFetch(limits: Web2Limits = web2Limits()): typeof fetch {
    const bounded = async (
        input: Parameters<typeof fetch>[0],
        init: RequestInit = {},
    ): Promise<Response> => {
        const controller = new AbortController()
        let timedOut = false
        const timer = setTimeout(() => {
            timedOut = true
            controller.abort()
        }, limits.timeoutMs)
        const outer = init.signal
        const onOuterAbort = () => controller.abort(outer?.reason)
        if (outer) {
            if (outer.aborted) controller.abort(outer.reason)
            else outer.addEventListener("abort", onOuterAbort, { once: true })
        }
        try {
            const res = await runtimeFetch()(input, { ...init, signal: controller.signal })
            const declared = Number(res.headers.get("content-length"))
            if (Number.isFinite(declared) && declared > limits.maxBytes) {
                controller.abort()
                throw new Error(`Web2 response exceeds ${limits.maxBytes} bytes`)
            }
            const body = await readCapped(
                res.body as unknown as AsyncIterable<Uint8Array> | null,
                limits.maxBytes,
            )
            // The body is already decoded, so the wire encoding and length
            // no longer describe it.
            const headers = new Headers(res.headers)
            headers.delete("content-encoding")
            headers.delete("content-length")
            return new Response(NULL_BODY_STATUSES.has(res.status) ? null : body, {
                status: res.status,
                statusText: res.statusText,
                headers,
            })
        } catch (error) {
            if (timedOut) {
                throw new Error(`Web2 request did not complete within ${limits.timeoutMs} ms`)
            }
            throw error
        } finally {
            clearTimeout(timer)
            // A long-lived caller signal would otherwise hold one listener,
            // and this request's controller, per request.
            outer?.removeEventListener("abort", onOuterAbort)
        }
    }
    return bounded as typeof fetch
}
