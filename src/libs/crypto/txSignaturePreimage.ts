/**
 * What a transaction signature commits to.
 *
 * Pre-fork the signed bytes are `TextEncoder(tx.hash)` — the bare 64-char hex
 * digest of the content — which carries no statement about what was signed or
 * where it is valid. Two consequences:
 *
 *  1. Any signature over a 64-hex string is a transaction signature. A wallet
 *     asked to "sign this login nonce" produces one, because the nonce is
 *     attacker-chosen and can be the hash of a transaction the attacker built.
 *  2. Nothing binds the signature to a network, so a transaction accepted on
 *     one chain replays byte-for-byte on another that shares the account.
 *
 * Post-fork the signed bytes become `demos-tx:v1:<chainId>:<hash>`. The
 * transaction content, its hash and the wire format are untouched — only the
 * preimage the signature covers changes — so stored transactions, indexers and
 * block hashes stay as they are.
 *
 * This module is imported by `txValidator.ts`, which runs inside validator
 * worker threads: keep it dependency-free (no shared state, no logger, no
 * SDK barrel).
 */

/** Marks the bytes as a Demos transaction, versioned for future changes. */
export const TX_SIGNATURE_DOMAIN = "demos-tx:v1:"

/**
 * The bytes a transaction signature covers.
 *
 * @param hash - `tx.hash`, the hex digest of the canonical content.
 * @param chainId - The network's `properties.id` from genesis. Ignored while
 *   the fork is inactive.
 * @param forkActive - Whether `signatureDomain` is active at the height being
 *   validated. False reproduces the legacy bytes exactly, so re-syncing an
 *   old chain verifies as it always did.
 */
export function txSignaturePreimage(
    hash: string,
    chainId: number,
    forkActive: boolean,
): Uint8Array {
    if (!forkActive) {
        return new TextEncoder().encode(hash)
    }
    return new TextEncoder().encode(
        `${TX_SIGNATURE_DOMAIN}${chainId}:${hash}`,
    )
}
