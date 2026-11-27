import type { RPCResponse } from "@kynesyslabs/demosdk/types"
import { DAHRFactory } from "src/features/web2/dahr/DAHRFactory"
import { validateAndNormalizeHttpUrl } from "src/features/web2/validator"

/**
 * The reply for a web2Request broadcast whose response this node already
 * fetched and attested in the same session, or null when there is none and
 * the request must be fetched again. Fetching again would repeat a request
 * the origin may not treat as idempotent, and the tx records the first
 * response either way.
 */
export function attestedWeb2Response(
    sessionId: unknown,
    raw: { url?: unknown; method?: unknown } | undefined,
    claimed: unknown,
): RPCResponse | null {
    if (typeof sessionId !== "string" || typeof raw?.url !== "string") {
        return null
    }
    const validation = validateAndNormalizeHttpUrl(raw.url)
    if (!validation.ok) return null
    const dahr = DAHRFactory.instance.getDAHR(sessionId)
    const attested = dahr?.takeAttestedResponse(
        validation.normalizedUrl,
        String(raw.method),
        claimed,
    )
    return attested
        ? { result: 200, response: attested, require_reply: false, extra: null }
        : null
}
