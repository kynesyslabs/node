/**
 * Transaction classification for Petri Consensus.
 *
 * PRE_APPROVED: Read-only transactions (no GCR edits). Soft finality ~2s.
 * TO_APPROVE: State-changing transactions pending delta agreement across shard.
 * PROBLEMATIC: Transactions where shard members disagree on the resulting state delta.
 */
export enum TransactionClassification {
    PRE_APPROVED = "PRE_APPROVED",
    TO_APPROVE = "TO_APPROVE",
    PROBLEMATIC = "PROBLEMATIC",
}

/**
 * A classified transaction wraps the original tx hash with its Petri classification
 * and tracks forge round metadata.
 */
export interface ClassifiedTransaction {
    txHash: string
    classification: TransactionClassification
    classifiedAt: number // timestamp
    forgeRound: number // the forge round when this was classified
    deltaHash?: string // hash of the state delta (only for TO_APPROVE)
    promotedAt?: number // timestamp when promoted to PRE_APPROVED (after agreement)
    rejectedAt?: number // timestamp when auto-rejected (TTL exceeded)
    roundsSeen: number // how many forge rounds this tx has been through
}
