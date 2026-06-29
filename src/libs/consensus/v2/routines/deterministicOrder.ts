import { normalizePubkey } from "@/libs/blockchain/gcr/handleGCR"
import { Transaction } from "@kynesyslabs/demosdk/types"

/**
 * Sorts a list of transactions deterministically
 *
 * @param txs - The transactions to sort
 * @returns The sorted transactions
 */
export function orderDeterministically<T extends Transaction>(txs: T[]): T[] {
    return [...txs].sort(compareTxDeterministic)
}

/**
 * Compare two txs by (sender ASC, nonce ASC, hash ASC). Plain string/number
 * comparison only — NO localeCompare (locale-sensitive, would diverge across
 * nodes with different locales).
 */
export function compareTxDeterministic(
    txa: Transaction,
    txb: Transaction,
): number {
    const sa = normalizePubkey(txa.content.from_ed25519_address)
    const sb = normalizePubkey(txb.content.from_ed25519_address)

    if (sa < sb) return -1
    if (sa > sb) return 1

    const na = txa.content.nonce
    const nb = txb.content.nonce

    if (na !== nb) return na - nb

    const ha = txa.hash ?? ""
    const hb = txb.hash ?? ""

    if (ha < hb) return -1
    if (ha > hb) return 1

    return 0
}
