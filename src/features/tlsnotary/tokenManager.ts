/**
 * TLSNotary Attestation Token Manager
 *
 * Manages in-memory tokens for paid TLSNotary attestation access.
 * Tokens are domain-locked, expire after 30 minutes, and allow 3 retries.
 *
 * @module features/tlsnotary/tokenManager
 */

// REVIEW: TLSNotary token management for paid attestation access
import { randomUUID } from "crypto"
import { isForkActive } from "@/forks/forkGates"
import {
    findLiveTlsnRequest,
    getOnChainTlsnRequest,
    type TlsnRequestRefusal,
} from "@/libs/tlsnotary/onchainRequests"
import log from "@/utilities/logger"
import { getSharedState } from "@/utilities/sharedState"

/**
 * Token configuration constants
 */
export const TOKEN_CONFIG = {
    EXPIRY_MS: 30 * 60 * 1000, // 30 minutes
    MAX_RETRIES: 3,
    CLEANUP_INTERVAL_MS: 60 * 1000, // cleanup every minute
}

/**
 * Token status enum
 */
export enum TokenStatus {
    PENDING = "pending", // Created, not yet used
    ACTIVE = "active", // Proxy spawned, attestation in progress
    COMPLETED = "completed", // Attestation successful
    STORED = "stored", // Proof stored on-chain/IPFS
    EXHAUSTED = "exhausted", // Max retries reached
    EXPIRED = "expired", // Time limit exceeded
}

/**
 * Attestation token structure
 */
export interface AttestationToken {
    id: string
    owner: string // pubkey of the payer
    domain: string // locked domain (e.g., "api.example.com")
    status: TokenStatus
    createdAt: number // timestamp
    expiresAt: number // timestamp
    retriesLeft: number
    txHash: string // original payment tx hash
    proxyId?: string // linked proxy ID once spawned
}

/**
 * Token store state (stored in sharedState)
 */
export interface TokenStoreState {
    tokens: Map<string, AttestationToken>
    cleanupTimer?: ReturnType<typeof setInterval>
}

/**
 * Generate a cryptographically secure UUID for token IDs
 */
function generateTokenId(): string {
    return `tlsn_${randomUUID()}`
}

/**
 * Get or initialize the token store from sharedState
 */
function getTokenStore(): TokenStoreState {
    const sharedState = getSharedState
    if (!sharedState.tlsnTokenStore) {
        sharedState.tlsnTokenStore = {
            tokens: new Map<string, AttestationToken>(),
        }
        // Start cleanup timer
        startCleanupTimer()
        log.info("[TLSNotary] Initialized token store")
    }
    return sharedState.tlsnTokenStore
}

/**
 * Start periodic cleanup of expired tokens
 */
function startCleanupTimer(): void {
    const store = getSharedState.tlsnTokenStore
    if (store && !store.cleanupTimer) {
        store.cleanupTimer = setInterval(() => {
            cleanupExpiredTokens()
        }, TOKEN_CONFIG.CLEANUP_INTERVAL_MS)
        log.debug("[TLSNotary] Started token cleanup timer")
    }
}

/**
 * Extract domain from a URL
 */
export function extractDomain(targetUrl: string): string {
    try {
        const url = new URL(targetUrl)
        return url.hostname
    } catch {
        throw new Error(`Invalid URL: ${targetUrl}`)
    }
}

/**
 * Create a new attestation token
 *
 * @param owner - Public key of the token owner
 * @param targetUrl - Target URL (domain will be extracted and locked)
 * @param txHash - Transaction hash of the payment
 * @returns The created token
 */
export function createToken(
    owner: string,
    targetUrl: string,
    txHash: string,
): AttestationToken {
    const store = getTokenStore()
    const now = Date.now()
    const domain = extractDomain(targetUrl)

    const token: AttestationToken = {
        id: generateTokenId(),
        owner,
        domain,
        status: TokenStatus.PENDING,
        createdAt: now,
        expiresAt: now + TOKEN_CONFIG.EXPIRY_MS,
        retriesLeft: TOKEN_CONFIG.MAX_RETRIES,
        txHash,
    }

    store.tokens.set(token.id, token)
    log.info(
        `[TLSNotary] Created token ${token.id} for ${domain} (owner: ${owner.substring(0, 16)}...)`,
    )

    return token
}

/**
 * Validation result for token checks
 */
export interface TokenValidationResult {
    valid: boolean
    error?: string
    token?: AttestationToken
}

/**
 * Validate a token for use
 *
 * @param tokenId - Token ID to validate
 * @param owner - Public key claiming to own the token
 * @param targetUrl - Target URL being requested
 * @returns Validation result with token if valid
 */
export function validateToken(
    tokenId: string,
    owner: string,
    targetUrl: string,
): TokenValidationResult {
    const store = getTokenStore()
    const token = store.tokens.get(tokenId)

    if (!token) {
        return { valid: false, error: "TOKEN_NOT_FOUND" }
    }

    // Check ownership
    if (token.owner !== owner) {
        return { valid: false, error: "TOKEN_OWNER_MISMATCH" }
    }

    // Check expiry
    if (Date.now() > token.expiresAt) {
        token.status = TokenStatus.EXPIRED
        return { valid: false, error: "TOKEN_EXPIRED" }
    }

    // Check domain lock
    const requestedDomain = extractDomain(targetUrl)
    if (token.domain !== requestedDomain) {
        return { valid: false, error: "TOKEN_DOMAIN_MISMATCH", token }
    }

    // Check status
    if (token.status === TokenStatus.EXHAUSTED) {
        return { valid: false, error: "TOKEN_EXHAUSTED" }
    }
    if (token.status === TokenStatus.EXPIRED) {
        return { valid: false, error: "TOKEN_EXPIRED" }
    }
    if (token.status === TokenStatus.STORED) {
        return { valid: false, error: "TOKEN_ALREADY_STORED" }
    }

    // Check retries
    if (token.retriesLeft <= 0) {
        token.status = TokenStatus.EXHAUSTED
        return { valid: false, error: "TOKEN_NO_RETRIES_LEFT" }
    }

    return { valid: true, token }
}

const CHAIN_REFUSAL_ERRORS: Record<TlsnRequestRefusal, string> = {
    NOT_FOUND: "TOKEN_NOT_FOUND",
    OWNER_MISMATCH: "TOKEN_OWNER_MISMATCH",
    DOMAIN_MISMATCH: "TOKEN_DOMAIN_MISMATCH",
    EXPIRED: "TOKEN_EXPIRED",
    // The pre-fork error name: a used token was a stored one.
    ALREADY_USED: "TOKEN_ALREADY_STORED",
}

/**
 * Validate a token for proxy access. Under `tlsnVerified` the token is the
 * on-chain `tlsn_request` row: `tokenId` is the request tx hash, and it must
 * be owned by `owner`, locked to the URL's host, not yet stored and not
 * expired at the next block. Any node can then serve it, and a restart
 * loses nothing. The in-memory token is only this node's retry count for
 * that row, created on first use. Before the fork, the in-memory token
 * created at admission is the token, as {@link validateToken} checks it.
 */
export async function validateProxyToken(
    tokenId: string,
    owner: string,
    targetUrl: string,
): Promise<TokenValidationResult> {
    if (!isForkActive("tlsnVerified", getSharedState.lastBlockNumber ?? 0)) {
        return validateToken(tokenId, owner, targetUrl)
    }
    let domain: string
    try {
        domain = extractDomain(targetUrl)
    } catch {
        return { valid: false, error: "TOKEN_DOMAIN_MISMATCH" }
    }
    const chain = await findLiveTlsnRequest(tokenId, {
        sender: owner,
        height: (getSharedState.lastBlockNumber ?? 0) + 1,
        domain,
        pendingOnly: true,
    })
    if (chain.ok === false) {
        return { valid: false, error: CHAIN_REFUSAL_ERRORS[chain.reason] }
    }

    const store = getTokenStore()
    const id = chain.request.tokenId
    let token = store.tokens.get(id)
    if (!token) {
        const now = Date.now()
        token = {
            id,
            owner: chain.request.owner,
            domain: chain.request.domain,
            status: TokenStatus.PENDING,
            createdAt: now,
            // Local bookkeeping only: the chain's expiry height decides.
            expiresAt: now + TOKEN_CONFIG.EXPIRY_MS,
            retriesLeft: TOKEN_CONFIG.MAX_RETRIES,
            txHash: id,
        }
        store.tokens.set(id, token)
    }
    if (token.retriesLeft <= 0) {
        token.status = TokenStatus.EXHAUSTED
        return { valid: false, error: "TOKEN_NO_RETRIES_LEFT" }
    }
    return { valid: true, token }
}

/**
 * Consume a retry attempt and mark token as active
 *
 * @param tokenId - Token ID
 * @param proxyId - Proxy ID being spawned
 * @returns Updated token or null if not found
 */
export function consumeRetry(
    tokenId: string,
    proxyId: string,
): AttestationToken | null {
    const store = getTokenStore()
    const token = store.tokens.get(tokenId)

    if (!token) {
        return null
    }

    token.retriesLeft -= 1
    token.status = TokenStatus.ACTIVE
    token.proxyId = proxyId

    log.info(
        `[TLSNotary] Token ${tokenId} consumed retry (${token.retriesLeft} left), proxyId: ${proxyId}`,
    )

    if (token.retriesLeft <= 0) {
        log.warning(`[TLSNotary] Token ${tokenId} has no retries left`)
    }

    return token
}

/**
 * Mark token as completed (attestation successful)
 *
 * @param tokenId - Token ID
 * @returns Updated token or null if not found
 */
export function markCompleted(tokenId: string): AttestationToken | null {
    const store = getTokenStore()
    const token = store.tokens.get(tokenId)

    if (!token) {
        return null
    }

    token.status = TokenStatus.COMPLETED
    log.info(`[TLSNotary] Token ${tokenId} marked as completed`)

    return token
}

/**
 * Mark token as stored (proof saved on-chain or IPFS)
 *
 * @param tokenId - Token ID
 * @returns Updated token or null if not found
 */
export function markStored(tokenId: string): AttestationToken | null {
    const store = getTokenStore()
    const token = store.tokens.get(tokenId)

    if (!token) {
        return null
    }

    token.status = TokenStatus.STORED
    log.info(`[TLSNotary] Token ${tokenId} marked as stored`)

    return token
}

/**
 * Get a token by ID
 *
 * @param tokenId - Token ID
 * @returns Token or undefined
 */
export function getToken(tokenId: string): AttestationToken | undefined {
    const store = getTokenStore()
    return store.tokens.get(tokenId)
}

/**
 * Get token by transaction hash
 *
 * @param txHash - Transaction hash
 * @returns Token or undefined
 */
export function getTokenByTxHash(txHash: string): AttestationToken | undefined {
    const store = getTokenStore()
    for (const token of store.tokens.values()) {
        if (token.txHash === txHash) {
            return token
        }
    }
    return undefined
}

/** A token as `tlsnotary.getToken` reports it. */
export interface TokenView {
    id: string
    owner: string
    domain: string
    status: TokenStatus
    /** Local proxy bookkeeping, ms; null when this node has not served the token yet. */
    expiresAt: number | null
    /** Last block height the chain accepts the token at (tlsnVerified only). */
    expiresAtHeight?: number
    retriesLeft: number
}

/**
 * The token `idOrTxHash` names. Under tlsnVerified it is the committed
 * request, so a client finds it as soon as the request is in a block, with
 * this node's retry count once the proxy has served it.
 */
export async function lookupToken(idOrTxHash: string): Promise<TokenView | null> {
    const tip = getSharedState.lastBlockNumber ?? 0
    if (!isForkActive("tlsnVerified", tip)) {
        const token = getToken(idOrTxHash) ?? getTokenByTxHash(idOrTxHash)
        if (!token) return null
        const { id, owner, domain, status, expiresAt, retriesLeft } = token
        return { id, owner, domain, status, expiresAt, retriesLeft }
    }
    const request = await getOnChainTlsnRequest(idOrTxHash)
    if (!request) return null
    const local = getToken(request.tokenId)
    let status = local?.status ?? TokenStatus.PENDING
    if (request.status === "stored") status = TokenStatus.STORED
    // Used up by an identity link: attested, nothing stored.
    else if (request.status === "linked") status = TokenStatus.COMPLETED
    else if (tip + 1 > request.expiresAtHeight) status = TokenStatus.EXPIRED
    return {
        id: request.tokenId,
        owner: request.owner,
        domain: request.domain,
        status,
        expiresAt: local?.expiresAt ?? null,
        expiresAtHeight: request.expiresAtHeight,
        retriesLeft: local?.retriesLeft ?? TOKEN_CONFIG.MAX_RETRIES,
    }
}

/**
 * Cleanup expired tokens
 */
export function cleanupExpiredTokens(): number {
    const store = getTokenStore()
    const now = Date.now()
    let cleaned = 0

    for (const [id, token] of store.tokens) {
        if (now > token.expiresAt && token.status !== TokenStatus.STORED) {
            store.tokens.delete(id)
            cleaned++
        }
    }

    if (cleaned > 0) {
        log.debug(`[TLSNotary] Cleaned up ${cleaned} expired tokens`)
    }

    return cleaned
}

/**
 * Get token store statistics
 */
export function getTokenStats(): {
    total: number
    byStatus: Record<TokenStatus, number>
} {
    const store = getTokenStore()
    const byStatus = {
        [TokenStatus.PENDING]: 0,
        [TokenStatus.ACTIVE]: 0,
        [TokenStatus.COMPLETED]: 0,
        [TokenStatus.STORED]: 0,
        [TokenStatus.EXHAUSTED]: 0,
        [TokenStatus.EXPIRED]: 0,
    }

    for (const token of store.tokens.values()) {
        byStatus[token.status]++
    }

    return {
        total: store.tokens.size,
        byStatus,
    }
}
