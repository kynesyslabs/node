/**
 * Who may open a TLSNotary proxy session on this node, and how often.
 *
 * The capability is a confirmed tlsn_request on chain, signed by the caller:
 * its hash is the token id, so any RPC node can serve it and a restart loses
 * nothing. Everything else here (sessions per token, live sessions and request
 * rates per owner and per address) is node-local and off consensus.
 *
 * @module features/tlsnotary/proxyAccess
 */
import { isForkActive } from "@/forks/forkGates"
import { rateLimitSubject } from "@/libs/network/middleware/rateLimitSubject"
import { bindSenderForm } from "@/libs/tlsnotary/identityPolicy"
import { tlsnRequestOf, tlsnRequestRefusal, type TlsnRequestRefusal } from "@/libs/tlsnotary/onchainRequests"
import { blockTimestampSec, findTlsnRequest, findTlsnRequestTx } from "@/libs/tlsnotary/tlsnChainReads"
import { getSharedState } from "@/utilities/sharedState"
import { PROXY_LIMITS, TOKEN_CONFIG } from "./constants"
import { liveSessions, type RelaySession } from "./proxyRelay"

export interface ProxyAccessRequest {
    tokenId: unknown
    /** Address proven by the request's signature; "" when unsigned. */
    sender: string
    /** The legacy free-form field; when present it must name the signer. */
    owner?: unknown
    targetUrl: string
    clientIP?: string
    now?: number
}

export interface ProxyRefusal {
    ok: false
    status: number
    error: string
    message: string
}

export interface ProxyGrant {
    ok: true
    txHash: string
    owner: string
    clientKey: string
    domain: string
    expiresAtMs: number
    /** Sessions the token can still open after this one. */
    sessionsLeft: number
    /** The token's live session, which the new one replaces. */
    supersedes?: RelaySession
    /** Records the session as opened; call once, after it is listening. */
    commit(proxyId: string): void
    /** Drops the reservation when no session was opened. */
    release(): void
}

interface TokenUse {
    sessions: number
    expiresAtMs: number
    /** Set for an on-chain token: its counts live until the chain expires it. */
    expiresAtHeight?: number
    inFlight: boolean
    liveProxyId?: string
}

interface Window {
    start: number
    count: number
}

const tokenUses = new Map<string, TokenUse>()
const pendingByOwner = new Map<string, number>()
const pendingByIp = new Map<string, number>()
const ipWindows = new Map<string, Window>()
const ownerWindows = new Map<string, Window>()

/** The sessions this node has left for a token it served, for tlsnotary.getToken. */
export function proxyTokenUse(txHash: string): { sessionsLeft: number; expiresAtMs: number } | null {
    const use = tokenUses.get(txHash)
    if (!use) return null
    return { sessionsLeft: Math.max(0, PROXY_LIMITS.MAX_SESSIONS_PER_TOKEN - use.sessions), expiresAtMs: use.expiresAtMs }
}

/** Forgets every counter; tests only. */
export function resetProxyAccessState(): void {
    tokenUses.clear()
    pendingByOwner.clear()
    pendingByIp.clear()
    ipWindows.clear()
    ownerWindows.clear()
}

const TX_HASH = /^[0-9a-f]{64}$/

/** The token id as the transactions table keys it, or null. */
export function normalizeTokenId(tokenId: unknown): string | null {
    if (typeof tokenId !== "string") return null
    const hex = tokenId.trim().toLowerCase().replace(/^0x/, "")
    return TX_HASH.test(hex) ? hex : null
}

function refuse(status: number, error: string, message: string): ProxyRefusal {
    return { ok: false, status, error, message }
}

/** Counts one call; true when the key is over its budget for the window. */
function overBudget(windows: Map<string, Window>, key: string, limit: number, now: number): boolean {
    if (windows.size > 10_000) {
        for (const [k, w] of windows) {
            if (now - w.start >= PROXY_LIMITS.RATE_WINDOW_MS) windows.delete(k)
        }
    }
    const window = windows.get(key)
    if (!window || now - window.start >= PROXY_LIMITS.RATE_WINDOW_MS) {
        windows.set(key, { start: now, count: 1 })
        return false
    }
    window.count += 1
    return window.count > limit
}

function bump(map: Map<string, number>, key: string, by: number): void {
    const next = (map.get(key) ?? 0) + by
    if (next <= 0) map.delete(key)
    else map.set(key, next)
}

function hostOf(url: string | null): string | null {
    if (!url) return null
    try {
        return new URL(url).hostname.toLowerCase()
    } catch {
        return null
    }
}

function forgetExpiredTokens(now: number, nextHeight: number): void {
    for (const [hash, use] of tokenUses) {
        const expired =
            use.expiresAtHeight !== undefined ? nextHeight > use.expiresAtHeight : now > use.expiresAtMs
        if (expired && !use.inFlight) tokenUses.delete(hash)
    }
}

const TOKEN_REFUSALS: Record<TlsnRequestRefusal, [number, string, string]> = {
    NOT_FOUND: [404, "TOKEN_NOT_FOUND", "No tlsn_request with this hash on chain"],
    OWNER_MISMATCH: [403, "TOKEN_OWNER_MISMATCH", "The tlsn_request was sent by another account"],
    DOMAIN_MISMATCH: [403, "TOKEN_DOMAIN_MISMATCH", "The tlsn_request is for another host"],
    EXPIRED: [403, "TOKEN_EXPIRED", "The tlsn_request has expired"],
    ALREADY_USED: [403, "TOKEN_ALREADY_STORED", "The tlsn_request already backs a stored or linked attestation"],
}

type TokenCheck = { expiresAtMs: number; expiresAtHeight?: number } | ProxyRefusal

/**
 * Under tlsnVerified the token is the gcr_tlsnotary row the request wrote:
 * the same row, expiry height and single use the store and identity apply
 * judge, so the proxy never serves a token they would refuse.
 */
async function checkChainToken(txHash: string, owner: string, domain: string, now: number): Promise<TokenCheck> {
    const tip = getSharedState.lastBlockNumber ?? 0
    const request = tlsnRequestOf(await findTlsnRequest(txHash))
    const refusal = tlsnRequestRefusal(request, { sender: owner, height: tip + 1, domain, pendingOnly: true })
    if (refusal !== null || !request) return refuse(...TOKEN_REFUSALS[refusal ?? "NOT_FOUND"])
    // Wall time only bounds the relay session; expiry itself is the height.
    const blocksLeft = request.expiresAtHeight - tip
    return {
        expiresAtMs: now + blocksLeft * getSharedState.getConsensusTime() * 1000,
        expiresAtHeight: request.expiresAtHeight,
    }
}

/** Before tlsnVerified no token row exists: the confirmed transaction is the token. */
async function checkRequestTx(txHash: string, owner: string, domain: string, now: number): Promise<TokenCheck> {
    const request = await findTlsnRequestTx(txHash)
    if (!request) return refuse(404, "TOKEN_NOT_FOUND", "No tlsn_request with this hash on chain")
    if (
        request.status !== "confirmed" ||
        request.type !== "native" ||
        request.nativeOperation !== "tlsn_request"
    ) {
        return refuse(403, "TOKEN_NOT_CONFIRMED", "The token is not a confirmed tlsn_request")
    }
    if (bindSenderForm(request.sender) !== owner) {
        return refuse(403, "TOKEN_OWNER_MISMATCH", "The tlsn_request was sent by another account")
    }
    if (hostOf(request.targetUrl) !== domain) {
        return refuse(403, "TOKEN_DOMAIN_MISMATCH", "The tlsn_request is for another host")
    }
    const blockSec = await blockTimestampSec(request.blockNumber)
    if (blockSec === null) {
        return refuse(503, "TOKEN_BLOCK_UNKNOWN", "This node does not hold the block of the tlsn_request")
    }
    const expiresAtMs = blockSec * 1000 + TOKEN_CONFIG.EXPIRY_MS
    if (now > expiresAtMs) return refuse(403, "TOKEN_EXPIRED", "The tlsn_request has expired")
    return { expiresAtMs }
}

/**
 * Decides a requestTLSNproxy call. On success the caller holds a reservation
 * that counts against every limit until it commits or releases it.
 */
export async function authorizeProxyRequest(
    req: ProxyAccessRequest,
): Promise<ProxyGrant | ProxyRefusal> {
    const now = req.now ?? Date.now()
    const clientKey = rateLimitSubject(req.clientIP || "unknown")

    // Unsigned calls are refused before they are counted, so a stranger
    // behind the same address cannot spend a signer's budget for free.
    if (!req.sender) {
        return refuse(
            401,
            "AUTH_REQUIRED",
            "requestTLSNproxy must be signed by the account that sent the tlsn_request",
        )
    }
    // Counted before any database read, so a flood costs this node nothing
    // but a map update.
    if (overBudget(ipWindows, clientKey, PROXY_LIMITS.REQUESTS_PER_WINDOW_PER_IP, now)) {
        return refuse(429, "RATE_LIMITED", "Too many proxy requests from this address")
    }
    const owner = bindSenderForm(req.sender)
    if (req.owner !== undefined && req.owner !== null && req.owner !== "") {
        if (typeof req.owner !== "string" || bindSenderForm(req.owner) !== owner) {
            return refuse(403, "TOKEN_OWNER_MISMATCH", "owner is not the signer of this request")
        }
    }
    if (overBudget(ownerWindows, owner, PROXY_LIMITS.REQUESTS_PER_WINDOW_PER_OWNER, now)) {
        return refuse(429, "RATE_LIMITED", "Too many proxy requests from this account")
    }

    const txHash = normalizeTokenId(req.tokenId)
    if (!txHash) {
        return refuse(400, "INVALID_TOKEN", "tokenId must be the hash of a tlsn_request (64 hex characters)")
    }
    const domain = hostOf(req.targetUrl)
    if (!domain) return refuse(400, "INVALID_URL", "targetUrl is not a URL")

    const tip = getSharedState.lastBlockNumber ?? 0
    const token = isForkActive("tlsnVerified", tip)
        ? await checkChainToken(txHash, owner, domain, now)
        : await checkRequestTx(txHash, owner, domain, now)
    if ("ok" in token) return token
    const { expiresAtMs, expiresAtHeight } = token

    // From here to the reservation nothing awaits, so concurrent calls see
    // each other's reservations.
    forgetExpiredTokens(now, (getSharedState.lastBlockNumber ?? 0) + 1)
    const use = tokenUses.get(txHash) ?? { sessions: 0, expiresAtMs, expiresAtHeight, inFlight: false }
    if (use.inFlight) {
        return refuse(409, "TOKEN_BUSY", "A proxy for this token is being opened")
    }
    if (use.sessions >= PROXY_LIMITS.MAX_SESSIONS_PER_TOKEN) {
        return refuse(403, "TOKEN_EXHAUSTED", "This token has opened all its proxy sessions")
    }
    const live = liveSessions()
    const supersedes = live.find(s => s.proxyId === use.liveProxyId && !s.endReason)
    const others = live.filter(s => s !== supersedes)
    const ownerLive =
        others.filter(s => s.owner === owner).length + (pendingByOwner.get(owner) ?? 0)
    if (ownerLive >= PROXY_LIMITS.MAX_LIVE_SESSIONS_PER_OWNER) {
        return refuse(429, "OWNER_SESSION_LIMIT", "This account has too many live proxy sessions")
    }
    const ipLive =
        others.filter(s => s.clientKey === clientKey).length + (pendingByIp.get(clientKey) ?? 0)
    if (ipLive >= PROXY_LIMITS.MAX_LIVE_SESSIONS_PER_IP) {
        return refuse(429, "IP_SESSION_LIMIT", "This address has too many live proxy sessions")
    }

    use.inFlight = true
    tokenUses.set(txHash, use)
    bump(pendingByOwner, owner, 1)
    bump(pendingByIp, clientKey, 1)
    let settled = false
    const settle = () => {
        if (settled) return false
        settled = true
        use.inFlight = false
        bump(pendingByOwner, owner, -1)
        bump(pendingByIp, clientKey, -1)
        return true
    }
    return {
        ok: true,
        txHash,
        owner,
        clientKey,
        domain,
        expiresAtMs,
        sessionsLeft: PROXY_LIMITS.MAX_SESSIONS_PER_TOKEN - use.sessions - 1,
        supersedes,
        commit(proxyId: string) {
            if (!settle()) return
            use.sessions += 1
            use.liveProxyId = proxyId
        },
        release() {
            settle()
        },
    }
}
