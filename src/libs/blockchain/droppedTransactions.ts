import { getSharedState } from "@/utilities/sharedState"
import type { DropReason } from "./chainTypes"
import { REFERENCE_BLOCK_ROOM, referenceBlockRoomAt } from "./referenceBlockWindow"

/**
 * Transactions this node removed from its mempool without a block taking
 * them, so getTransactionStatus can answer "dropped" instead of "unknown".
 *
 * Node-local and in memory only: nothing is written to the chain or the
 * database, a restart forgets it, and another node may hold or include the
 * same tx. The chain and the mempool are read first, so an inclusion, a
 * failed record or a tx that came back to the pool wins over an entry here.
 */

export interface DroppedTx {
    reason: DropReason
    final: boolean
    droppedAtBlock: number
    droppedAt: number
}

/**
 * Most entries held; past it the oldest go first. Five full pools
 * (MEMPOOL_MAX_TXS is 10,000): an entry outlives five complete turnovers of
 * a full pool. A flood that churns faster ages entries out sooner, and those
 * hashes read "unknown" again, as before. An entry is a 64-hex hash and four
 * scalar fields, no peer-supplied text, so the bound on entries bounds the
 * memory: about 200 bytes an entry, 10 MB at the cap (measured, Bun 1.4.4).
 */
export const DROPPED_TX_LIMIT = 50_000

// Insertion order is drop order, so the first key is the oldest entry.
const dropped = new Map<string, DroppedTx>()

/**
 * Whether no node can include a tx dropped for `reason` at head `height`.
 *
 * Only a reference block behind the deep window qualifies: forging drops it
 * (filterMempoolByRefBlock), the merge refuses it (Mempool.receive), and the
 * cutoff never moves back, except once when referenceBlockRoom10 widens the
 * room, so not before that fork is active. An age-expired tx is not final:
 * the lifetime is checked only at admission and by each node's own sweep,
 * and the merge takes it from a peer that has not swept it yet. The others
 * are this node's own pool policy or verdict.
 */
export function isFinalDrop(reason: DropReason, height: number): boolean {
    return (
        reason === "reference_block_expired" &&
        referenceBlockRoomAt(height) === REFERENCE_BLOCK_ROOM
    )
}

/**
 * Records `hashes` as dropped for `reason` at head `height`. A later drop of
 * the same hash replaces the entry, unless the entry is final.
 */
export function recordDropped(
    hashes: Iterable<string>,
    reason: DropReason,
    height: number = getSharedState.lastBlockNumber ?? 0,
): void {
    const final = isFinalDrop(reason, height)
    const droppedAt = Date.now()
    for (const hash of hashes) {
        if (typeof hash !== "string") continue
        const key = hash.toLowerCase()
        if (dropped.get(key)?.final) continue
        dropped.delete(key)
        dropped.set(key, { reason, final, droppedAtBlock: height, droppedAt })
        if (dropped.size > DROPPED_TX_LIMIT) {
            dropped.delete(dropped.keys().next().value as string)
        }
    }
}

/**
 * Records the txs a finished round removes from the pool for failing the
 * filters of its block (`removed`) that the block does not carry.
 */
export function recordRefusedForBlock(
    removed: Iterable<string>,
    blockTxs: Array<{ hash: string }>,
): void {
    const carried = new Set(blockTxs.map(tx => tx.hash))
    recordDropped([...removed].filter(hash => !carried.has(hash)), "refused_for_block")
}

export function getDroppedTx(hash: string): DroppedTx | null {
    return dropped.get(hash.toLowerCase()) ?? null
}

/** Tests only. */
// eslint-disable-next-line @typescript-eslint/naming-convention
export function __clearDroppedTxs(): void {
    dropped.clear()
}
