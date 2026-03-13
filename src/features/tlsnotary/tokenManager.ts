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
import log from "@/utilities/logger"
import { getSharedState } from "@/utilities/sharedState"
import { TOKEN_CONFIG } from "./constants"
import type { AttestationToken, TokenStoreState, TokenValidationResult } from "./types"
import { TokenStatus } from "./types"

// Re-export for backward compatibility
export { TOKEN_CONFIG } from "./constants"
export { TokenStatus } from "./types"
export type { AttestationToken, TokenStoreState } from "./types"

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
  log.info(`[TLSNotary] Created token ${token.id} for ${domain} (owner: ${owner.substring(0, 16)}...)`)

  return token
}

// Re-export TokenValidationResult for backward compatibility
export type { TokenValidationResult } from "./types"

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

/**
 * Consume a retry attempt and mark token as active
 *
 * @param tokenId - Token ID
 * @param proxyId - Proxy ID being spawned
 * @returns Updated token or null if not found
 */
export function consumeRetry(tokenId: string, proxyId: string): AttestationToken | null {
  const store = getTokenStore()
  const token = store.tokens.get(tokenId)

  if (!token) {
    return null
  }

  token.retriesLeft -= 1
  token.status = TokenStatus.ACTIVE
  token.proxyId = proxyId

  log.info(`[TLSNotary] Token ${tokenId} consumed retry (${token.retriesLeft} left), proxyId: ${proxyId}`)

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
