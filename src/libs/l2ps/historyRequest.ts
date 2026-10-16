import { Config } from "src/config"
import {
    isOwnHistoryHost,
    readPageValue,
    type HistoryPageParams,
} from "./historyAuth"

/** A request turned away before any signature is checked. */
export interface HistoryRefusal {
    result: number
    response: string
    /** Present only where the caller is told how to sign. */
    extra?: unknown
}

export interface HistoryRequest {
    /** Chosen by the request, never inferred from the signature. */
    isV2: boolean
    page: HistoryPageParams
}

const MAX_LIMIT = 1000
const REQUEST_MAX_AGE_MS = 5 * 60 * 1000
const REQUEST_MAX_AHEAD_MS = 60 * 1000

const refuse = (result: number, response: string, extra?: unknown): HistoryRefusal => ({
    result,
    response,
    ...(extra === undefined ? {} : { extra }),
})

export const isRefusal = (value: HistoryRefusal | HistoryRequest): value is HistoryRefusal =>
    "result" in value

/**
 * The values are used as strings later (prefix stripping, the signed
 * message), so a number or object here would otherwise surface as a
 * TypeError from the handler instead of a refusal.
 */
function checkTypes(data: Record<string, any>): HistoryRefusal | null {
    if (
        typeof data.l2psUid !== "string" ||
        typeof data.address !== "string" ||
        typeof data.signature !== "string"
    ) {
        return refuse(400, "Subnet, address and signature must be strings.")
    }
    return null
}

function checkTimestamp(timestamp: unknown, now: number): HistoryRefusal | null {
    const requestTime =
        typeof timestamp === "string" || typeof timestamp === "number"
            ? Number.parseInt(String(timestamp), 10)
            : Number.NaN
    if (
        Number.isNaN(requestTime) ||
        now - requestTime > REQUEST_MAX_AGE_MS ||
        requestTime > now + REQUEST_MAX_AHEAD_MS
    ) {
        return refuse(401, "Request expired or invalid timestamp.")
    }
    return null
}

/**
 * Applied page values. The unversioned form signs none of them, so a
 * fractional or out-of-range value cannot be refused without breaking
 * existing clients; it is made a whole number the table can take instead. A
 * version 2 value is checked as supplied and refused when it is not whole.
 *
 * Only a missing value takes the default: a supplied zero is clamped to the
 * documented minimum, so the signed value and the applied value agree.
 */
function applyPage(data: Record<string, any>, isV2: boolean): HistoryPageParams {
    const whole = (value: number) =>
        isV2 ? value : Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER)
    return {
        limit: whole(Math.min(Math.max(1, readPageValue(data.limit) ?? 100), MAX_LIMIT)),
        offset: whole(Math.max(0, readPageValue(data.offset) ?? 0)),
        since: whole(Math.max(0, readPageValue(data.since) ?? 0)),
    }
}

/** A supplied page value that is not a number would otherwise fall back to a default the caller never signed. */
function hasUnreadablePageValue(data: Record<string, any>): boolean {
    return [data.limit, data.offset, data.since].some(
        value => value !== undefined && value !== null && readPageValue(value) === undefined,
    )
}

/** What a version 2 request has to carry before its signature is worth checking. */
function checkV2Binding(data: Record<string, any>, page: HistoryPageParams): HistoryRefusal | null {
    // The message is joined with ":", so a segment that can carry one would
    // let two different requests produce the same string.
    if (
        !/^\d+$/.test(String(data.timestamp)) ||
        data.l2psUid.includes(":") ||
        data.address.includes(":")
    ) {
        return refuse(400, "Malformed timestamp, subnet or address.")
    }
    if (!data.host) {
        return refuse(401, "A version 2 signature requires the host it is bound to.")
    }
    // Bound to the node so a signature collected by or relayed through one
    // node cannot be presented to another serving the same subnet.
    if (!isOwnHistoryHost(data.host)) {
        return refuse(403, "Signature is bound to another host.")
    }
    if (hasUnreadablePageValue(data) || !Object.values(page).every(Number.isSafeInteger)) {
        return refuse(400, "limit, offset and since must be integers.")
    }
    return null
}

/**
 * Everything checked before the signature, in the order a caller meets it.
 * Nothing here may throw on hostile input: it runs before authentication.
 */
export function parseHistoryRequest(
    data: Record<string, any>,
    now: number,
    hint: () => unknown,
): HistoryRequest | HistoryRefusal {
    if (!data.l2psUid || !data.address) {
        return refuse(400, "L2PS UID and address are required")
    }
    if (!data.signature || !data.timestamp) {
        return refuse(401, "Authentication required. Provide signature and timestamp.", hint())
    }
    const refusal = checkTypes(data) ?? checkTimestamp(data.timestamp, now)
    if (refusal) return refusal

    // An explicit null is a malformed version, not an omitted one, so it is
    // refused rather than quietly served with the weaker legacy form. Version
    // 2 is chosen by the request: the two signed strings differ in their first
    // segment, so a relay that strips the marker only turns it into a refusal.
    const isV2 = data.signatureVersion !== undefined
    if (isV2 && data.signatureVersion !== 2 && data.signatureVersion !== "2") {
        return refuse(400, "Unsupported signatureVersion.")
    }
    if (!isV2 && Config.getInstance().l2ps.historyRequireV2) {
        return refuse(401, "This node requires a version 2 history signature.", hint())
    }

    const page = applyPage(data, isV2)
    const binding = isV2 ? checkV2Binding(data, page) : null
    return binding ?? { isV2, page }
}
