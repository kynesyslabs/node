/**
 * Result of comparing a local delta hash against peer delta hashes
 * for a single transaction within a forge round.
 */
export interface DeltaComparison {
    txHash: string
    localDeltaHash: string
    peerHashes: Map<string, string> // peerKey -> deltaHash
    agreeCount: number // number of peers with matching hash (including self)
    disagreeCount: number // number of peers with different hash
    missingCount: number // number of peers that didn't respond
    totalMembers: number // total shard members
    agreed: boolean // true if agreeCount >= agreementThreshold
}

/**
 * Aggregated result of delta comparison across all transactions in a forge round.
 */
export interface RoundDeltaResult {
    roundNumber: number
    comparisons: DeltaComparison[]
    promotedTxHashes: string[] // txs that reached agreement
    problematicTxHashes: string[] // txs where agreement was not reached
    timestamp: number
}
