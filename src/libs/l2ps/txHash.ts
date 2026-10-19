/**
 * A transaction hash as the queue stores it: SHA-256, lower-case hex.
 *
 * The queue's primary key is the outer transaction's hash, which no path
 * recomputes, so a holder of a subnet key could otherwise store any text there.
 * The consolidated digest sorts those keys in the database's byte order and
 * the digest was defined over the JavaScript string sort. The two agree on
 * every string made of hex characters and can disagree on others
 * (supplementary-plane characters sort differently in UTF-16), so only hashes
 * of this form are admitted.
 */
const L2PS_TX_HASH = /^[0-9a-f]{64}$/

export function isValidL2PSTxHash(hash: unknown): hash is string {
    return typeof hash === "string" && L2PS_TX_HASH.test(hash)
}
