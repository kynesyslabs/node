/**
 * Data structure for a single escrow
 */
export interface EscrowData {
    claimableBy: {
        platform: "twitter" | "github" | "telegram" | "discord"
        username: string // e.g., "@bob" or "octocat"
    }
    balance: string // Stringified bigint for JSONB compatibility
    deposits: EscrowDeposit[]
    expiryBlock: number // First block height at which the escrow is expired
    createdBlock: number // Height of the block that created the escrow
    // Claimed status to prevent race conditions
    claimed?: boolean
    claimedBy?: string // Address that claimed the escrow
    claimedBlock?: number // Height of the block that applied the claim
}

/**
 * A single deposit into an escrow
 */
export interface EscrowDeposit {
    from: string // Sender's Ed25519 public key (hex)
    amount: string // Stringified bigint
    block: number // Height of the block that applied the deposit
    timestamp: number // Signer-chosen tx timestamp, display only (never used for validity)
    message?: string // Optional memo from sender
    refunded?: boolean // Refunded to the depositor; kept so the refund can be rolled back
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
    platform: "twitter" | "github" | "telegram" | "discord"
    username: string
    balance: string // Stringified bigint
    escrowAddress: string
    deposits: Array<{
        from: string
        amount: string
        block: number
        timestamp: number
        message?: string
    }>
    expiryBlock: number
    expired: boolean
}
