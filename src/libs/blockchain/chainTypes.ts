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
 *   - "unknown"  — not found anywhere
 *
 * "included" keeps its name for SDKs that wait on it; it is never returned
 * for a transaction that did not execute. `code` and `message` are advisory:
 * the block does not commit to them, and a node that synced the block keeps
 * what the forger served for failures inside apply.
 */
export type TxStatus = {
    state: "pending" | "included" | "failed" | "unknown"
    blockNumber?: number
    code?: string
    message?: string
}
