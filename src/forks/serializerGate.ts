import type { TransactionContent, BlockContent } from "@kynesyslabs/demosdk/types"
import { denomination } from "@kynesyslabs/demosdk"
import { isForkActive } from "./forkGates"
import { canonicalizeAmountToOs } from "./amountCanonical"

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
 * Coerce a wire-format amount/fee value to an OS `bigint` using the
 * shared canonicalization helper (myc#76, GH#3213223280).
 *
 * Pre-fork wire format encodes amounts as JS `number` in DEM. Post-fork
 * wire format encodes them as decimal strings in OS. The serializer must
 * accept either shape on input — even when called with the fork active —
 * because:
 *
 *  1. During the SDK rollout (P4+), an old client may submit a tx with
 *     `amount: number` (DEM); the post-fork serializer is the boundary
 *     where this gets normalised to OS string before hashing.
 *  2. Re-hashing a stored, already-OS-encoded tx must yield the same
 *     bytes (idempotency); we re-parse and re-emit so that any
 *     non-canonical OS string (e.g. `"00100"`) is rewritten canonically
 *     (`"100"`).
 *
 * `bigint` inputs are also accepted for completeness — the SDK migration
 * (P4) will use `bigint` internally, and code paths that bypass the wire
 * may pass it directly.
 *
 * Throws when the input cannot be expressed as a non-negative OS amount
 * (e.g. a fractional `number` smaller than 1 OS, a non-numeric string).
 *
 * Always called with `forkActive=true` from this file — the gate above
 * (`isForkActive("osDenomination", blockHeight)`) is the only entry
 * into `transformToOsTransactionContent`. The shared helper takes the
 * flag so the executor can call the SAME helper at canonicalization
 * time and stay self-consistent with this serializer.
 *
 * @param value - DEM `number`, OS decimal `string`, or OS `bigint`.
 * @returns OS amount as `bigint`.
 */
function toOsBigint(value: number | string | bigint): bigint {
    return canonicalizeAmountToOs(value, /* forkActive */ true)
}

/**
 * Re-emit a `TransactionContent` with `amount` and `transaction_fee.*`
 * encoded as canonical OS decimal strings.
 *
 * Property order is preserved: object spread (`{ ...content }`) keeps the
 * source's key insertion order, and overwriting `amount` /
 * `transaction_fee` does not change the order of those existing keys.
 * This is consensus-critical: hashes are computed by `JSON.stringify`,
 * which serialises keys in insertion order.
 *
 * Fields other than `amount` and `transaction_fee` are passed through
 * verbatim. In particular, `gcr_edits[].amount` is **not** transformed
 * here — once SDK v3 ships (P4), that field is already populated with
 * OS-string amounts by the SDK, and the serializer is not its source of
 * truth. P3a deliberately scopes itself to the wire-level fields the
 * fork is about (top-level `amount`, `transaction_fee`).
 *
 * @param content - Pre-fork or post-fork transaction content.
 * @returns A new `TransactionContent` ready for `JSON.stringify`.
 */
function transformToOsTransactionContent(
    content: TransactionContent,
): TransactionContent {
    // Spread preserves the source's insertion order. We then overwrite
    // the wire-format-sensitive fields in place.
    const transformed = { ...content } as TransactionContent

    if (typeof content.amount !== "undefined" && content.amount !== null) {
        const osAmount = toOsBigint(content.amount as number | string | bigint)
        // Cast through `unknown` because the SDK's `TransactionContent.amount`
        // is still typed as `number` in v2.x; the wire shape is what the
        // fork changes, not the static type. SDK v3 (P4) widens the type.
        transformed.amount = denomination.toOsString(osAmount) as unknown as number
    }

    if (content.transaction_fee) {
        const fee = content.transaction_fee
        transformed.transaction_fee = {
            network_fee: denomination.toOsString(
                toOsBigint(fee.network_fee as number | string | bigint),
            ) as unknown as number,
            rpc_fee: denomination.toOsString(
                toOsBigint(fee.rpc_fee as number | string | bigint),
            ) as unknown as number,
            additional_fee: denomination.toOsString(
                toOsBigint(fee.additional_fee as number | string | bigint),
            ) as unknown as number,
        }
    }

    return transformed
}

/**
 * Serialize transaction content for hashing/signing.
 *
 * Block-height gated:
 *  - **Pre-fork** (`activationHeight === null` or `blockHeight < activationHeight`):
 *    legacy `JSON.stringify(content)` — `amount: number` (DEM),
 *    `transaction_fee.*: number` (DEM).
 *  - **Post-fork**: `amount` and `transaction_fee.*` are converted to
 *    canonical OS decimal strings, all other fields pass through
 *    verbatim and in the original key order.
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
    if (isForkActive("osDenomination", blockHeight)) {
        return JSON.stringify(transformToOsTransactionContent(content))
    }
    return JSON.stringify(content)
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
