import type { Transaction } from "@kynesyslabs/demosdk/types"
import { getSharedState } from "@/utilities/sharedState"
import { isForkActive } from "./forkGates"

/**
 * The transaction types that carry L2PS traffic: a client's encrypted
 * subnet transaction (`l2psEncryptedTx`, and `subnet`, which the node hands
 * to the same handler), the batch a node settles a subnet's transactions
 * with (`l2psBatch`) and a subnet's consolidated hash (`l2ps_hash_update`).
 */
export const L2PS_TX_TYPES: ReadonlySet<string> = new Set([
    "l2psEncryptedTx",
    "l2psBatch",
    "l2ps_hash_update",
    "subnet",
])

export const L2PS_GATE_REFUSAL = "L2PS is not enabled on this network (fork l2psGate)"

type TxView = Pick<Transaction, "content"> | { content?: unknown }

/** Whether L2PS is off for the block applied on `tip`. */
export function l2psOffAt(tip: number): boolean {
    return isForkActive("l2psGate", tip)
}

/**
 * Whether L2PS is off at this node's tip, for the handlers and services that
 * answer outside a block. Judged at the tip like admission, so a node never
 * serves L2PS while its pool refuses it.
 */
export function l2psOff(): boolean {
    return l2psOffAt(getSharedState.lastBlockNumber ?? 0)
}

/** Whether `tx` is one of the L2PS transaction types. */
export function isL2psTx(tx: TxView): boolean {
    const content = (tx as { content?: unknown }).content
    if (!content || typeof content !== "object") return false
    const type = (content as Record<string, unknown>).type
    return typeof type === "string" && L2PS_TX_TYPES.has(type)
}

/**
 * Why `tx` is refused under `l2psGate`, or null when it passes. `off` is
 * `l2psOffAt` for the block the transaction would land in, read from the
 * same tip as the other admission and apply gates.
 */
export function l2psGateRefusal(tx: TxView, off: boolean): string | null {
    return off && isL2psTx(tx) ? L2PS_GATE_REFUSAL : null
}
