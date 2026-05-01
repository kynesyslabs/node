import type { TransactionContent, BlockContent } from "@kynesyslabs/demosdk/types"
import { isForkActive } from "./forkGates"

// REVIEW: P2 — serializer gate. Both branches return JSON.stringify(content)
// until P3 implements the post-fork serializer. P2 must remain bit-identical
// to pre-P2 behavior at every hash site, regardless of the configured fork
// state, because no fork has an activationHeight set in production.

/**
 * Serialize transaction content for hashing/signing.
 *
 * Block-height gated: the pre-fork branch uses the legacy `JSON.stringify`
 * serializer. Post-fork, this function will route through a canonical OS
 * serializer (P3). Until then, the post-fork branch is a placeholder that
 * also returns `JSON.stringify(content)` so that even if a fork were
 * accidentally activated, the byte output remains identical to the legacy
 * path.
 *
 * @param content The transaction content to serialize.
 * @param blockHeight The reference block height. For pending transactions
 *   use the current chain height (`Chain.getLastBlockNumber()`); for blocks
 *   already in the chain pass the block's own number. Genesis is `0`.
 * @returns Canonical JSON string for hashing.
 */
export function serializeTransactionContent(
    content: TransactionContent,
    blockHeight: number,
): string {
    if (isForkActive("osDenomination", blockHeight)) {
        // P3 will implement the post-fork serializer here.
        // P2 contract: both branches must produce identical bytes so that
        // landing the gate does not change any existing transaction hash.
        return JSON.stringify(content)
    }
    return JSON.stringify(content)
}

/**
 * Serialize block content for hashing.
 *
 * See {@link serializeTransactionContent} for the gating contract; the same
 * P2 bit-identical guarantee applies here.
 *
 * @param content The block content to serialize.
 * @param blockHeight The block's own number. Genesis is `0`.
 * @returns Canonical JSON string for hashing.
 */
export function serializeBlockContent(
    content: BlockContent,
    blockHeight: number,
): string {
    if (isForkActive("osDenomination", blockHeight)) {
        // P3 placeholder — see comment above.
        return JSON.stringify(content)
    }
    return JSON.stringify(content)
}
