export interface L2PSHashUpdatePayload {
    l2ps_uid: string
    consolidated_hash: string
    transaction_count: number
}

/**
 * Transaction lifecycle state returned by Chain.getTransactionStatus.
 *
 *   - "pending"  — present in mempool, not yet included in a block
 *   - "included" — present in the transactions table, has a block number
 *   - "failed"   — reserved (the node does not currently record execution
 *                  failures, so failed txs surface as "unknown")
 *   - "unknown"  — not found anywhere
 */
export type TxStatus = {
    state: "pending" | "included" | "failed" | "unknown"
    blockNumber?: number
}
