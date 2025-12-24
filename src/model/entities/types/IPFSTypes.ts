/**
 * IPFS Types for Account State
 *
 * Defines the structure for IPFS-related data stored in account state.
 * Used by GCRMain entity for tracking user's pinned content and rewards.
 *
 * @fileoverview IPFS account state type definitions
 */

/**
 * Represents a single pinned content item on IPFS
 *
 * Tracks content that a user has pinned through the Demos Network,
 * including size for storage tracking and optional expiration.
 */
export interface PinnedContent {
    /** Content Identifier (CID) - unique hash of the content */
    cid: string

    /** Size of the content in bytes */
    size: number

    /** Unix timestamp when the content was pinned */
    timestamp: number

    /** Optional Unix timestamp when the pin expires (for time-limited pins) */
    expiresAt?: number

    /** Optional metadata associated with the pin */
    metadata?: Record<string, unknown>
}

/**
 * IPFS state stored in user's account
 *
 * Tracks all IPFS-related state for an account including:
 * - Pinned content list
 * - Storage usage
 * - Economic tracking (rewards/costs)
 */
export interface AccountIPFSState {
    /** Array of pinned content items */
    pins: PinnedContent[]

    /** Total bytes of pinned content (cached for efficiency) */
    totalPinnedBytes: number

    /**
     * Rewards earned from IPFS operations (stored as string for bigint serialization)
     * NOTE: JSONB doesn't natively support bigint, so we store as string
     */
    earnedRewards: string

    /**
     * Costs paid for IPFS operations (stored as string for bigint serialization)
     * NOTE: JSONB doesn't natively support bigint, so we store as string
     */
    paidCosts: string

    /** Last time IPFS state was updated */
    lastUpdated?: number
}

/**
 * Default empty IPFS state for new accounts
 */
export const DEFAULT_IPFS_STATE: AccountIPFSState = {
    pins: [],
    totalPinnedBytes: 0,
    earnedRewards: "0",
    paidCosts: "0",
}
