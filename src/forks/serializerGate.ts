import type { TransactionContent, BlockContent } from "@kynesyslabs/demosdk/types"
import { isForkActive } from "./forkGates"
import { serializeTxContent } from "@/libs/crypto/txContentSerializer"

// REVIEW: P3a — post-fork branch implements the canonical OS-string
// serializer for transactions. The pre-fork branch is unchanged
// (`JSON.stringify(content)`), so a node booting with the default fork
// config (`activationHeight: null`) is bit-identical to a pre-P3a node.
//
// For blocks, the post-fork branch is intentionally a no-op: `BlockContent`
// has no amount/fee fields, so the byte representation is the same on both
// sides of the fork. The transactions referenced from a block are hashed
// individually upstream and only their hashes appear in `BlockContent`.

/**
 * Serialize transaction content for hashing/signing.
 *
 * Block-height gated:
 *  - **Pre-fork** (`activationHeight === null` or `blockHeight < activationHeight`):
 *    legacy `JSON.stringify(content)` — `amount: number` (DEM),
 *    `transaction_fee.*: number` (DEM).
 *  - **Post-fork**: `amount`, `transaction_fee.*` and the amounts inside
 *    `gcr_edits[]` are converted to canonical OS decimal strings, all other
 *    fields pass through verbatim and in the original key order. The bytes
 *    come from {@link serializeTxContent}, the same function the mempool
 *    validator uses, so the two ingress paths cannot disagree.
 *
 * @param content - The transaction content to serialize.
 * @param blockHeight - The reference block height. For pending
 *   transactions use the current chain height
 *   (`Chain.getLastBlockNumber()`); for blocks already in the chain pass
 *   the block's own number. Genesis is `0`.
 * @returns Canonical JSON string for hashing.
 */
export function serializeTransactionContent(
    content: TransactionContent,
    blockHeight: number,
): string {
    return serializeTxContent(
        content,
        isForkActive("osDenomination", blockHeight),
    )
}

/**
 * Serialize block content for hashing.
 *
 * P3a finding: `BlockContent` (see `@kynesyslabs/demosdk/types`) has no
 * amount/fee fields — it stores transaction *hashes*, peer lists, and
 * table digests. The fork therefore changes nothing at the block-content
 * level; both branches return identical bytes. The transactions inside
 * the block were already serialised through
 * {@link serializeTransactionContent}, so block coherence is correctly
 * gated transitively.
 *
 * The fork-aware branch is preserved (instead of removed) so that a
 * future fork that *does* change `BlockContent` can plug a transformer
 * here without re-touching all block hash sites.
 *
 * @param content - The block content to serialize.
 * @param blockHeight - The block's own number. Genesis is `0`.
 * @returns Canonical JSON string for hashing.
 */
export function serializeBlockContent(
    content: BlockContent,
    blockHeight: number,
): string {
    if (isForkActive("osDenomination", blockHeight)) {
        // No-op for `osDenomination`: BlockContent has no amount/fee fields.
        // Kept as an explicit branch so future forks can add a transformer
        // without re-routing all block hash sites.
        return JSON.stringify(content)
    }
    return JSON.stringify(content)
}
