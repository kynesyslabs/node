import { Transaction } from "@kynesyslabs/demosdk/types"

// ponytail: inline the forge-buffer -> hex coercion instead of importing
// forgeToHex, which transitively pulls in logger -> sharedState -> the whole
// chain/datasource graph. This module must stay a leaf so it is cheap to load
// and unit-testable in isolation. Mirrors forgeUtils.forgeToHex behaviour for
// the only shapes a tx `from` field takes (hex string, Uint8Array/Buffer, or a
// serialized {type:"Buffer",data:number[]}).
function toHexLower(from: unknown): string {
    if (typeof from === "string") return from.toLowerCase()
    let buf = from as { type?: string; data?: number[] } | Uint8Array
    if ((buf as { type?: string }).type === "Buffer") {
        buf = (buf as { data: number[] }).data as unknown as Uint8Array
    }
    return Buffer.from(buf as Uint8Array).toString("hex").toLowerCase()
}

/**
 * Deterministic total order over a merged mempool: (sender, nonce, hash).
 *
 * P-ORDER (Epic #21): the previous ordering was by timestamp, which is
 * node-variant, so two honest nodes forging the same merged set produced
 * different block hashes -> vote divergence -> consensus stalls. Sorting by
 * (sender, nonce, hash) is a pure function of the tx set, so every honest
 * node with the same merged mempool produces a byte-identical
 * ordered_transactions list. It also guarantees same-sender txs are laid out
 * in nonce order, which the apply path follows.
 *
 * The sort is total and fully tie-broken (sender, then nonce, then the
 * globally-unique tx hash), so there is no residual non-determinism.
 */
export function senderKey(tx: Transaction): string {
    return toHexLower(tx.content?.from)
}

function nonceOf(tx: Transaction): number {
    const n = tx.content?.nonce
    // Missing/invalid nonce sorts last within a sender (defensive; such txs
    // are rejected elsewhere). NaN-safe: treat as +Infinity.
    return typeof n === "number" && Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER
}

/**
 * Compare two txs by (sender ASC, nonce ASC, hash ASC). Plain string/number
 * comparison only — NO localeCompare (locale-sensitive, would diverge across
 * nodes with different locales).
 */
export function compareTxDeterministic(a: Transaction, b: Transaction): number {
    const sa = senderKey(a)
    const sb = senderKey(b)
    if (sa < sb) return -1
    if (sa > sb) return 1

    const na = nonceOf(a)
    const nb = nonceOf(b)
    if (na !== nb) return na - nb

    const ha = a.hash ?? ""
    const hb = b.hash ?? ""
    if (ha < hb) return -1
    if (ha > hb) return 1
    return 0
}

/**
 * Return a new array sorted deterministically. Does not mutate the input.
 */
export function orderDeterministically<T extends Transaction>(txs: T[]): T[] {
    return [...txs].sort(compareTxDeterministic)
}
