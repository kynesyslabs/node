/** Proof checks per block stay within about a second of block validation. */
export const MAX_SETTLEMENT_BATCHES_PER_BLOCK = 20

/**
 * The batches a block may settle: the first MAX_SETTLEMENT_BATCHES_PER_BLOCK
 * `l2psBatch` transactions in the order given, which every caller passes in
 * canonical order. The rest are left out by forging and failed by apply.
 */
export function settlementBatchesOverCap<T extends { hash: string; content: { type?: unknown } }>(
    ordered: readonly T[],
): Set<string> {
    const over = new Set<string>()
    let seen = 0
    for (const tx of ordered) {
        if (tx.content?.type !== "l2psBatch") continue
        seen++
        if (seen > MAX_SETTLEMENT_BATCHES_PER_BLOCK) over.add(tx.hash)
    }
    return over
}
