import { createHash } from "node:crypto"
import { Transaction } from "@kynesyslabs/demosdk/types"
import { forgeToHex } from "@/libs/crypto/forgeUtils"
import { serializeTxContent } from "@/libs/crypto/txContentSerializer"
import {
    BLOCK_MAX_CONTENT_BYTES,
    BLOCK_MAX_TXS,
} from "@/utilities/constants"

export interface BlockCaps {
    maxTxs: number
    maxContentBytes: number
}

export const DEFAULT_BLOCK_CAPS: BlockCaps = {
    maxTxs: BLOCK_MAX_TXS,
    maxContentBytes: BLOCK_MAX_CONTENT_BYTES,
}

/**
 * Bytes of a tx's content as its hash commits to it. Only hash-bound bytes
 * count, so every node holding the tx measures the same size; signatures
 * and unsigned row fields may differ between copies of one tx.
 */
export function txContentBytes(
    tx: Pick<Transaction, "content">,
    osDenominationActive: boolean,
): number {
    try {
        return Buffer.byteLength(
            serializeTxContent(tx.content, osDenominationActive),
        )
    } catch {
        return Buffer.byteLength(JSON.stringify(tx.content) ?? "")
    }
}

/** The sender key compareTxDeterministic orders by (normalizePubkey). */
function senderOf(tx: Transaction): string {
    const account = tx.content.from_ed25519_address as string | Uint8Array
    return (
        typeof account === "string" ? account : forgeToHex(account)
    ).toLowerCase()
}

/** Per-block rank of a sender: fixed for the block, unrelated to its address. */
function senderRank(height: number, sender: string): string {
    return createHash("sha256").update(`${height}:${sender}`).digest("hex")
}

/**
 * The txs block `height` takes from a deterministically ordered pool, within
 * `caps`. Senders take turns, one tx per turn in nonce order, in an order
 * drawn per block from the height, so no sender is always first and none
 * is starved for good. A sender whose next tx does not fit the byte budget
 * takes no more in this block, which keeps its nonces contiguous. The
 * result keeps the input order; what is left stays pooled for later blocks.
 *
 * Depends only on the set of txs, the height and the caps, so members
 * holding the same pool select the same block.
 */
export function selectBlockTransactions<T extends Transaction>(
    ordered: readonly T[],
    height: number,
    osDenominationActive: boolean,
    caps: BlockCaps = DEFAULT_BLOCK_CAPS,
): T[] {
    const bytesOf = new Map<T, number>()
    let total = 0
    for (const tx of ordered) {
        const bytes = txContentBytes(tx, osDenominationActive)
        bytesOf.set(tx, bytes)
        total += bytes
    }
    if (ordered.length <= caps.maxTxs && total <= caps.maxContentBytes) {
        return [...ordered]
    }

    // `ordered` is sender then nonce order, so each queue is in nonce order.
    const queues = new Map<string, T[]>()
    for (const tx of ordered) {
        const sender = senderOf(tx)
        const queue = queues.get(sender)
        if (queue) queue.push(tx)
        else queues.set(sender, [tx])
    }
    const senders = [...queues.keys()]
        .map(sender => ({ sender, rank: senderRank(height, sender) }))
        .sort((a, b) =>
            a.rank !== b.rank
                ? a.rank < b.rank
                    ? -1
                    : 1
                : a.sender < b.sender
                  ? -1
                  : a.sender > b.sender
                    ? 1
                    : 0,
        )
        .map(entry => entry.sender)

    const selected = new Set<T>()
    const stopped = new Set<string>()
    let bytes = 0
    for (let turn = 0; selected.size < caps.maxTxs; turn++) {
        let took = false
        for (const sender of senders) {
            if (selected.size >= caps.maxTxs) break
            if (stopped.has(sender)) continue
            const tx = queues.get(sender)[turn]
            if (!tx) continue
            const size = bytesOf.get(tx)
            if (bytes + size > caps.maxContentBytes) {
                stopped.add(sender)
                continue
            }
            selected.add(tx)
            bytes += size
            took = true
        }
        if (!took) break
    }

    return ordered.filter(tx => selected.has(tx))
}

/**
 * Why no block can take `tx`, or null: its content alone is over the byte
 * cap of an empty block. Such a tx would sit in the pool until it expires,
 * and hold back every later nonce of its sender, so it is not admitted.
 */
export function oversizeTxRefusal(
    tx: Pick<Transaction, "content">,
    osDenominationActive: boolean,
    caps: BlockCaps = DEFAULT_BLOCK_CAPS,
): string | null {
    const bytes = txContentBytes(tx, osDenominationActive)
    return bytes > caps.maxContentBytes
        ? `Transaction content is ${bytes} bytes, over the block cap of ${caps.maxContentBytes}: no block can take it`
        : null
}

/**
 * Why a block's txs exceed `caps`, or null when they fit. Used to refuse
 * a rebuilt candidate that no honest member would have forged.
 */
export function blockCapsRefusal(
    txs: readonly Transaction[],
    osDenominationActive: boolean,
    caps: BlockCaps = DEFAULT_BLOCK_CAPS,
): string | null {
    if (txs.length > caps.maxTxs) {
        return `${txs.length} txs, over the block cap of ${caps.maxTxs}`
    }
    let bytes = 0
    for (const tx of txs) bytes += txContentBytes(tx, osDenominationActive)
    if (bytes > caps.maxContentBytes) {
        return `${bytes} bytes of tx content, over the block cap of ${caps.maxContentBytes}`
    }
    return null
}
