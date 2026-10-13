import { getSharedState } from "src/utilities/sharedState"
import { isLoopbackHost, parseNodeUrl } from "@/config/nodeUrl"

export const HISTORY_AUTH_V2_PREFIX = "getL2PSHistory/2"

export interface HistoryPageParams {
    limit: number
    offset: number
    since: number
}

/**
 * The string a caller signs to read its own history, version 2.
 *
 * The host is signed because a subnet uid is served by many nodes: without it
 * anything that can relay the request could present the same signature to a
 * different node and read that node's answer. The page parameters are signed
 * because they are applied after the signature check; unsigned, a relay could
 * withhold rows or serve another window while the signature still verifies.
 *
 * limit, offset and since are the values the node applies to the query (after
 * defaults and clamping), as plain decimal integers. A caller that omits one
 * therefore signs its default: limit 100, offset 0, since 0.
 */
export function historyAuthMessageV2(
    l2psUid: string,
    address: string,
    timestamp: string,
    host: string,
    page: HistoryPageParams,
): string {
    return [
        HISTORY_AUTH_V2_PREFIX,
        l2psUid,
        address,
        timestamp,
        host,
        page.limit,
        page.offset,
        page.since,
    ].join(":")
}

function stripHexPrefix(value: string): string {
    return value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value
}

/**
 * A page value as the request carried it: a number or a numeric string.
 * Anything else yields undefined, so a hostile value (an object with its own
 * valueOf, say) is never coerced and cannot throw before the signature check.
 */
export function readPageValue(raw: unknown): number | undefined {
    if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined
    if (typeof raw === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(raw)) {
        return Number(raw)
    }
    return undefined
}

/**
 * Whether `host` names this node: its ed25519 address, or the advertised
 * hostname. A loopback advertised URL is not an identity (every node on every
 * machine would answer to it), so it never matches.
 *
 * The bare hostname is accepted only when the advertised URL uses the default
 * port of its scheme. Otherwise two nodes behind one address on different
 * ports would share a binding, so host:port is required.
 */
export function isOwnHistoryHost(host: unknown): boolean {
    if (typeof host !== "string" || host.length === 0) return false

    const ownKey = getSharedState.publicKeyHex
    if (
        ownKey &&
        stripHexPrefix(host).toLowerCase() === stripHexPrefix(ownKey).toLowerCase()
    ) {
        return true
    }

    const advertised = parseNodeUrl(getSharedState.exposedUrl)
    if (!advertised || isLoopbackHost(advertised.hostname)) return false

    const wanted = host.toLowerCase()
    if (wanted === advertised.host.toLowerCase()) return true
    return advertised.port === "" && wanted === advertised.hostname.toLowerCase()
}
