import Hashing from "src/libs/crypto/hashing"

/**
 * Body-bound HTTP auth. The signature covers the identity, the timestamp and
 * the SHA-256 of the exact body bytes, so captured headers cannot carry
 * another body. The older form (identity and timestamp only) is still what
 * SDK clients send.
 */
export const HTTP_AUTH_DOMAIN = "DEMOS_HTTP_AUTH_V2"

/** Header carrying the hex SHA-256 of the request body the signature covers. */
export const BODY_HASH_HEADER = "body-hash"

/**
 * Methods only peers call, where the sender identity decides what the
 * request may do. They refuse the older form: its signature leaves the body
 * free, so captured headers could carry any body for that identity.
 */
export const BODY_BOUND_METHODS: ReadonlySet<string> = new Set([
    "hello_peer",
    "mempool",
    "consensus_routine",
])

export function httpAuthMessage(
    identity: string,
    timestamp: string | number,
    bodyHash: string,
): string {
    return Hashing.sha256(
        `${HTTP_AUTH_DOMAIN}:${identity}:${timestamp}:${bodyHash}`,
    )
}
