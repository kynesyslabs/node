// Ordering needs the key format only, not the GCR apply path behind it.
import { normalizePubkey } from "@/libs/blockchain/gcr/normalizePubkey"
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
 * Whether the canonical order can place `tx`. The comparison throws on a
 * sender that is not a string and on a missing hash, so a caller that sorts
 * transactions no signature check has vetted refuses these first: a throw
 * there stalls only the node that hit it.
 */
export function canonicallyOrderable(tx: {
    hash?: unknown
    content?: { from_ed25519_address?: unknown } | null
}): boolean {
    const sender = tx?.content?.from_ed25519_address
    return (
        typeof sender === "string" &&
        sender.length > 0 &&
        typeof tx.hash === "string" &&
        tx.hash.length > 0
    )
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
    const sa = normalizePubkey(txa.content.from_ed25519_address).toLowerCase()
    const sb = normalizePubkey(txb.content.from_ed25519_address).toLowerCase()

    if (sa < sb) return -1
    if (sa > sb) return 1

    const na = Number(txa.content.nonce)
    const nb = Number(txb.content.nonce)

    if (na !== nb) return na - nb

    const ha = txa.hash
    const hb = txb.hash

    if (!ha || !hb) {
        throw new Error(
            "compareTxDeterministic: missing tx hash — cannot order deterministically",
        )
    }

    if (ha < hb) return -1
    if (ha > hb) return 1

    return 0
}
