import type { Transaction } from "@kynesyslabs/demosdk/types"

/**
 * Put a block's transactions back in `ordered_transactions` order from
 * two sources: rows already pending in the local mempool and bodies
 * fetched from a peer. Mempool rows are retagged to the block they are
 * being applied under, the same rewrite the serving side of
 * `getTxsByHashes` performs for not-yet-finalised blocks.
 *
 * Hashes missing from both sources are omitted; the caller's block
 * verification catches the shortfall.
 */
export function assembleBlockTxs(
    orderedHashes: string[],
    local: Transaction[],
    fetched: Transaction[],
    blockNumber: number,
): Transaction[] {
    const byHash = new Map<string, Transaction>()
    for (const tx of fetched) {
        if (tx && typeof tx.hash === "string") byHash.set(tx.hash, tx)
    }
    for (const tx of local) {
        if (tx && typeof tx.hash === "string" && !byHash.has(tx.hash)) {
            byHash.set(tx.hash, { ...tx, blockNumber })
        }
    }
    const out: Transaction[] = []
    for (const hash of orderedHashes) {
        const tx = byHash.get(hash)
        if (tx) out.push(tx)
    }
    return out
}

/** Hashes in `orderedHashes` that `local` does not cover. */
export function missingHashes(
    orderedHashes: string[],
    local: Array<{ hash: string }>,
): string[] {
    const have = new Set(local.map(tx => tx.hash))
    return orderedHashes.filter(hash => !have.has(hash))
}
