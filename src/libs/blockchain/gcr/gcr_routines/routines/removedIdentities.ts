/**
 * The links an identity unlink removed, kept on this node so that undoing
 * the unlink can put back exactly what was there.
 *
 * A signed remove edit names the link (a username, an address) but does not
 * carry it: the proof, signature and timestamp only travel in the add edit
 * of an earlier transaction. The SDK builds these edits, so the edit cannot
 * grow the missing fields; this node records them when it applies the
 * remove instead. Nothing here is hashed, stored or served, so it cannot
 * change what any node agrees on: it only feeds rollback.
 *
 * Entries live as long as the process and the newest ones are kept. Every
 * rollback on this node undoes edits the same process applied: a block's
 * state commits together with the block, so a restart leaves nothing applied
 * that a later rollback would need to undo. An undo with no entry fails,
 * which the caller treats like any other failed rollback.
 */

export interface RemovedEntry<T = unknown> {
    /** Position the entry held in its list, so the undo restores the order. */
    index: number
    value: T
}

const LIMIT = 4096
const removed = new Map<string, RemovedEntry[]>()

export function removedIdentityKey(
    txhash: unknown,
    account: string,
    ...path: string[]
): string | null {
    if (typeof txhash !== "string" || txhash === "") return null
    return [txhash, account, ...path].join("\u0000")
}

export function recordRemovedIdentities(
    key: string | null,
    entries: RemovedEntry[],
): void {
    if (key === null) return
    removed.delete(key)
    removed.set(key, structuredClone(entries))
    while (removed.size > LIMIT) {
        removed.delete(removed.keys().next().value as string)
    }
}

/** A copy, so a failed undo can be retried from the same record. */
export function removedIdentities<T>(
    key: string | null,
): RemovedEntry<T>[] | null {
    if (key === null) return null
    const entries = removed.get(key)
    return entries ? (structuredClone(entries) as RemovedEntry<T>[]) : null
}

/** Puts entries back at the positions they were taken from. */
export function reinsert<T>(list: T[], entries: RemovedEntry<T>[]): T[] {
    const out = [...list]
    for (const { index, value } of [...entries].sort((a, b) => a.index - b.index)) {
        out.splice(Math.min(index, out.length), 0, value)
    }
    return out
}
