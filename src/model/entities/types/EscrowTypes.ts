/**
 * Data structure for a single escrow
 */
export interface EscrowData {
    claimableBy: {
        platform: "twitter" | "github" | "telegram"
        username: string // e.g., "@bob" or "octocat"
    }
    balance: string // Stringified bigint for JSONB compatibility
    deposits: EscrowDeposit[]
    expiryTimestamp: number // Unix timestamp in milliseconds
    createdAt: number
    // Claimed status to prevent race conditions
    claimed?: boolean
    claimedBy?: string // Address that claimed the escrow
    claimedAt?: number // Unix timestamp when claimed
}

/**
 * A single deposit into an escrow
 */
export interface EscrowDeposit {
    from: string // Sender's Ed25519 public key (hex)
    amount: string // Stringified bigint
    timestamp: number
    message?: string // Optional memo from sender
}

/**
 * Result of querying an escrow
 */
export interface EscrowQueryResult {
    escrowAddress: string
    exists: boolean
    data?: EscrowData
    claimable: boolean // Whether caller can claim this
    expired: boolean
}

/**
 * Claimable escrow list item
 */
export interface ClaimableEscrow {
    platform: "twitter" | "github" | "telegram"
    username: string
    balance: string // Stringified bigint
    escrowAddress: string
    deposits: Array<{
        from: string
        amount: string
        timestamp: number
        message?: string
    }>
    expiryTimestamp: number
    expired: boolean
}
