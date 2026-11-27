/**
 * Platforms a web2 link can name. Admission refuses any other context, so a
 * client is told up front instead of the transaction failing in a block.
 */
export const WEB2_CONTEXTS: ReadonlySet<string> = new Set([
    "twitter",
    "github",
    "discord",
    "telegram",
    "domain",
])

/** Platforms a TLSNotary proof can link; a subset of WEB2_CONTEXTS. */
export const TLSN_CONTEXTS: ReadonlySet<string> = new Set([
    "github",
    "discord",
    "telegram",
])

/**
 * TLSN_CONTEXTS under `keylessWeb2Identity`: Twitter links through
 * TLSNotary too once its web2 proof path is closed.
 */
export const TLSN_KEYLESS_CONTEXTS: ReadonlySet<string> = new Set([...TLSN_CONTEXTS, "twitter"])

/**
 * Whether indexing a plain object by this name reaches Object.prototype
 * (constructor, toString, __proto__ ...) instead of a stored entry. A link
 * bucket read by such a name yields a function or the prototype, and the
 * array methods apply calls on it throw.
 */
export function isInheritedKey(name: unknown): boolean {
    return String(name) in Object.prototype
}
