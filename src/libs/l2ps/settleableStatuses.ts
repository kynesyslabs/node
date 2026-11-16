/**
 * Queue statuses from which the settlement loop can still settle a transfer.
 * Kept apart from the mempool module so the history store can read it without
 * loading the chain.
 */
export const SETTLEABLE_QUEUE_STATUSES: readonly string[] = ["executed", "deferred", "batched"]
