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

    /**
     * Whether this pin used free tier allocation
     * Tracks for proper accounting when unpinning
     */
    wasFree?: boolean

    /**
     * How many bytes of this pin were covered by free tier
     * For partial free tier usage (e.g., file crosses free tier boundary)
     */
    freeBytes?: number

    /**
     * Cost paid for this pin in DEM (as string for bigint serialization)
     */
    costPaid?: string
}

/**
 * IPFS state stored in user's account
 *
 * Tracks all IPFS-related state for an account including:
 * - Pinned content list
 * - Storage usage
 * - Economic tracking (rewards/costs)
 * - Free tier allocation (for genesis accounts)
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

    /**
     * Free allocation in bytes for this account
     * Genesis accounts: 1GB (1073741824 bytes)
     * Regular accounts: 0
     * REVIEW: Future support for node operators and promotional allocations
     */
    freeAllocationBytes: number

    /**
     * How many bytes of the free allocation have been used
     * Tracks consumption of the free tier for genesis accounts
     */
    usedFreeBytes: number

    /** Last time IPFS state was updated */
    lastUpdated?: number
}

/**
 * Default empty IPFS state for new accounts
 * Note: freeAllocationBytes should be set based on account type (genesis vs regular)
 */
export const DEFAULT_IPFS_STATE: AccountIPFSState = {
    pins: [],
    totalPinnedBytes: 0,
    earnedRewards: "0",
    paidCosts: "0",
    freeAllocationBytes: 0,
    usedFreeBytes: 0,
}

/**
 * Create IPFS state for a genesis account with free allocation
 * @param freeBytes - Free allocation in bytes (default: 1GB)
 */
export function createGenesisIPFSState(
    freeBytes: number = 1024 * 1024 * 1024,
): AccountIPFSState {
    return {
        ...DEFAULT_IPFS_STATE,
        freeAllocationBytes: freeBytes,
    }
}
