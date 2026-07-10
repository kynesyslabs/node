import { verifySignatureOverMessage } from "src/libs/network/verifySignature"
import log from "src/utilities/logger"

/**
 * Optional authentication envelope for storage-program reads.
 *
 * `identity` is the signer in "algorithm:publicKeyHex" form. The public-key
 * portion is the ACL address form (it matches `program.owner` / `acl.allowed`
 * / group members, which are all the raw sender public key). `signature` is
 * over the canonical read message (see {@link readAuthMessage}) and
 * `timestamp` (unix ms) bounds replay to a freshness window.
 */
export interface StorageReadAuth {
    identity: string
    signature: string
    timestamp: number
}

/**
 * Freshness window for read-auth signatures (ms). A signature is only
 * accepted when its timestamp is within +/- this bound of the node clock,
 * limiting how long a captured signature can be replayed.
 */
export const READ_AUTH_MAX_SKEW_MS = 5 * 60 * 1000

/**
 * Canonical message a caller must sign to prove control of an address for a
 * read. Binds the signature to the queried resource (`scope`) and a
 * timestamp so it can't be replayed against a different resource or outside
 * the freshness window. The SDK must build the identical string when signing.
 */
export function readAuthMessage(scope: string, timestamp: number): string {
    return `demos.storageProgram.read:${scope}:${timestamp}`
}

/**
 * Scope builders for the canonical read message, one per read surface so a
 * signature for one query can't be reused for another.
 */
export const readAuthScope = {
    program: (storageAddress: string) => storageAddress,
    owner: (owner: string) => `owner:${owner}`,
    search: (query: string) => `search:${query}`,
}

function parseReadAuth(auth: unknown): StorageReadAuth | undefined {
    if (!auth || typeof auth !== "object") return undefined
    const a = auth as Record<string, unknown>
    if (typeof a.identity !== "string" || a.identity.length === 0) {
        return undefined
    }
    if (typeof a.signature !== "string" || a.signature.length === 0) {
        return undefined
    }
    if (typeof a.timestamp !== "number" || !Number.isFinite(a.timestamp)) {
        return undefined
    }
    return { identity: a.identity, signature: a.signature, timestamp: a.timestamp }
}

/**
 * Resolve the authenticated requester for a read.
 *
 * Returns the verified requester address (raw public-key hex, the ACL address
 * form) only when `auth` carries a fresh, valid signature over the canonical
 * message for `scope`; otherwise returns undefined (treated as anonymous).
 *
 * The requester is derived solely from the verified signature — a
 * caller-supplied address string is never trusted — so a non-public program
 * stays unreadable without cryptographic proof of key ownership. Fails closed
 * (undefined) on missing, malformed, stale, or invalid auth.
 */
export async function resolveReadRequester(
    scope: string,
    auth: unknown,
    now: number = Date.now(),
): Promise<string | undefined> {
    const parsed = parseReadAuth(auth)
    if (!parsed) return undefined

    if (Math.abs(now - parsed.timestamp) > READ_AUTH_MAX_SKEW_MS) {
        log.debug("[storageReadAuth] Rejected stale/future read-auth timestamp")
        return undefined
    }

    const result = await verifySignatureOverMessage(
        parsed.identity,
        parsed.signature,
        readAuthMessage(scope, parsed.timestamp),
    )
    if (!result.valid || !result.publicKey) return undefined

    return result.publicKey
}
