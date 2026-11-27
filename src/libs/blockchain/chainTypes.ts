export interface L2PSHashUpdatePayload {
    l2ps_uid: string
    consolidated_hash: string
    transaction_count: number
}

/**
 * Transaction lifecycle state returned by Chain.getTransactionStatus.
 *
 *   - "pending"  — present in mempool, not yet included in a block
 *   - "included" — in a block and executed
 *   - "failed"   — in a block but not executed (blocks keep failed
 *                  transactions); `code` and `message` say why
 *   - "dropped"  — this node removed it from its mempool without a block
 *                  taking it; `reason` says why (see droppedTransactions.ts)
 *   - "unknown"  — not found anywhere
 *
 * "included" keeps its name for SDKs that wait on it; it is never returned
 * for a transaction that did not execute. `code` and `message` are advisory:
 * the block does not commit to them, and a node that synced the block keeps
 * what the forger served for failures inside apply.
 *
 * "dropped" is node-local and bounded: a node that never held the tx, has
 * restarted since, or has forgotten it answers "unknown". It is never
 * terminal: another node may still include it, so a wallet must not re-sign
 * it with a new nonce.
 */
export type TxStatus = {
    state: "pending" | "included" | "failed" | "dropped" | "unknown"
    blockNumber?: number
    code?: string
    message?: string
    reason?: DropReason
    /** This node's head when it dropped the tx. */
    droppedAtBlock?: number
    /** When it dropped the tx, in milliseconds since the epoch. */
    droppedAt?: number
}

/** Why a node removed a tx from its mempool without a block taking it. */
export type DropReason =
    /** Signed timestamp past the pool lifetime (MEMPOOL_TX_TTL_MS), or unusable. */
    | "expired"
    /** Reference block behind the deep window. */
    | "reference_block_expired"
    /** Displaced by a higher-paying tx at a full pool. */
    | "evicted_fee"
    /** Over the per-sender pending cap. */
    | "evicted_sender_cap"
    /** Seat transaction refused by the staking re-judge. */
    | "seat_refused"
    /** Failed by the filters of the block this node forged, and not kept. */
    | "refused_for_block"
