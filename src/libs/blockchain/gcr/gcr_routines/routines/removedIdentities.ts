/**
 * The links an identity unlink removed, so that undoing the unlink can put
 * back exactly what was there.
 *
 * A signed remove edit names the link (a username, an address) but does not
 * carry it: the proof, signature and timestamp only travel in the add edit
 * of an earlier transaction, and the SDK that builds the edits cannot change
 * before launch. The records are never hashed, stored or served.
 *
 * They live in the entity caches of one apply, so undo is exact only for an
 * edit the same apply applied. After that the state is committed with its
 * block or dropped, and rollbackOrphanedGcrState cannot restore a remove: the
 * node falls back to a full resync, as before.
 */

export interface RemovedEntry<T = unknown> {
    /** Position the entry held in its list, so the undo restores the order. */
    index: number
    value: T
}

/** The records of one apply, by removedIdentityKey. */
export type RemovedIdentities = Map<string, RemovedEntry[]>

/** A copy, so a failed undo can be retried from the same record. */
export function recordedRemoval<T>(
    place: EditPlace | undefined,
    key: (place: EditPlace) => string,
): RemovedEntry<T>[] | null {
    const entries = place?.removed.get(key(place))
    return entries ? (structuredClone(entries) as RemovedEntry<T>[]) : null
}

/**
 * Where a block apply (not a simulation) meets an edit: its transaction,
 * its position among the transaction's edits, and the records of the apply.
 */
export interface EditPlace {
    txhash: string
    position: number
    removed: RemovedIdentities
}

/** Position is in the key: one transaction may unlink the same link twice. */
export function removedIdentityKey(
    place: EditPlace,
    account: string,
    ...path: string[]
): string {
    return [place.txhash, String(place.position), account, ...path].join(
        "\u0000",
    )
}

/** Puts entries back at the positions they were taken from. */
export function reinsert<T>(list: T[], entries: RemovedEntry<T>[]): T[] {
    const out = [...list]
    for (const { index, value } of [...entries].sort(
        (a, b) => a.index - b.index,
    )) {
        out.splice(Math.min(index, out.length), 0, value)
    }
    return out
}
