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

    /**
     * Original duration specified when pinning
     * Stored for extension calculations and UI display
     * REVIEW: DEM-481 - Added for pin expiration system
     */
    duration?: PinDurationPreset | number

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

// ============================================================================
// IPFS Storage Quotas (DEM-480)
// ============================================================================

/**
 * Account tier for quota determination
 * - regular: Standard user accounts
 * - genesis: Genesis block accounts (higher limits)
 * - premium: Future premium tier (reserved)
 */
export type QuotaTier = "regular" | "genesis" | "premium"

/**
 * Storage quota configuration for an account
 * Enforced at consensus level to prevent DoS attacks
 */
export interface StorageQuota {
    /** Maximum total pinned bytes allowed */
    maxPinnedBytes: number

    /** Maximum number of pins allowed */
    maxPinCount: number
}

/**
 * IPFS Quota constants - Protocol-defined limits
 * These are consensus-critical: all nodes MUST use identical values
 *
 * NOTE: Using number (not bigint) since these are reasonable sizes
 * 1GB = 1,073,741,824 bytes (fits in Number.MAX_SAFE_INTEGER)
 * 10GB = 10,737,418,240 bytes (fits in Number.MAX_SAFE_INTEGER)
 */
export const IPFS_QUOTA_LIMITS = {
    /** Regular accounts: 1 GB storage, 1000 pins max */
    regular: {
        maxPinnedBytes: 1 * 1024 * 1024 * 1024, // 1 GB
        maxPinCount: 1000,
    } as StorageQuota,

    /** Genesis accounts: 10 GB storage, 10000 pins max */
    genesis: {
        maxPinnedBytes: 10 * 1024 * 1024 * 1024, // 10 GB
        maxPinCount: 10000,
    } as StorageQuota,

    /** Premium accounts: Reserved for future use */
    premium: {
        maxPinnedBytes: 100 * 1024 * 1024 * 1024, // 100 GB
        maxPinCount: 100000,
    } as StorageQuota,
} as const

/**
 * Result of a quota check operation
 */
export interface QuotaCheckResult {
    /** Whether the operation is within quota limits */
    allowed: boolean

    /** Current storage usage in bytes */
    currentUsageBytes: number

    /** Current pin count */
    currentPinCount: number

    /** Maximum allowed bytes for this account */
    maxBytes: number

    /** Maximum allowed pins for this account */
    maxPins: number

    /** Remaining bytes available */
    remainingBytes: number

    /** Remaining pins available */
    remainingPins: number

    /** Error message if not allowed */
    errorMessage?: string
}

/**
 * Get the quota limits for a given account tier
 * @param tier - Account tier (regular, genesis, premium)
 * @returns StorageQuota for the tier
 */
export function getQuotaForTier(tier: QuotaTier): StorageQuota {
    return IPFS_QUOTA_LIMITS[tier]
}

/**
 * Check if an operation would exceed quota limits
 * This is the core quota validation function used during consensus
 *
 * @param currentState - Current IPFS state of the account
 * @param additionalBytes - Bytes to be added by this operation
 * @param tier - Account tier for quota lookup
 * @returns QuotaCheckResult with detailed quota information
 */
export function checkQuota(
    currentState: AccountIPFSState,
    additionalBytes: number,
    tier: QuotaTier,
): QuotaCheckResult {
    const quota = getQuotaForTier(tier)
    const currentUsageBytes = currentState.totalPinnedBytes
    const currentPinCount = currentState.pins.length
    const newTotalBytes = currentUsageBytes + additionalBytes
    const newPinCount = currentPinCount + 1

    const remainingBytes = quota.maxPinnedBytes - currentUsageBytes
    const remainingPins = quota.maxPinCount - currentPinCount

    // Check byte quota
    if (newTotalBytes > quota.maxPinnedBytes) {
        return {
            allowed: false,
            currentUsageBytes,
            currentPinCount,
            maxBytes: quota.maxPinnedBytes,
            maxPins: quota.maxPinCount,
            remainingBytes: Math.max(0, remainingBytes),
            remainingPins: Math.max(0, remainingPins),
            errorMessage: `IPFS_QUOTA_EXCEEDED: Adding ${additionalBytes} bytes would exceed storage quota. Current: ${currentUsageBytes}/${quota.maxPinnedBytes} bytes`,
        }
    }

    // Check pin count quota
    if (newPinCount > quota.maxPinCount) {
        return {
            allowed: false,
            currentUsageBytes,
            currentPinCount,
            maxBytes: quota.maxPinnedBytes,
            maxPins: quota.maxPinCount,
            remainingBytes: Math.max(0, remainingBytes),
            remainingPins: Math.max(0, remainingPins),
            errorMessage: `IPFS_QUOTA_EXCEEDED: Adding pin would exceed pin count quota. Current: ${currentPinCount}/${quota.maxPinCount} pins`,
        }
    }

    return {
        allowed: true,
        currentUsageBytes,
        currentPinCount,
        maxBytes: quota.maxPinnedBytes,
        maxPins: quota.maxPinCount,
        remainingBytes: remainingBytes - additionalBytes,
        remainingPins: remainingPins - 1,
    }
}


// ============================================================================
// IPFS Pin Expiration System (DEM-481)
// ============================================================================

/**
 * Named duration options for pin expiration
 * - permanent: Never expires (default behavior)
 * - week: 7 days
 * - month: 30 days
 * - quarter: 90 days
 * - year: 365 days
 */
export type PinDurationPreset = "permanent" | "week" | "month" | "quarter" | "year"

/**
 * Pin duration can be a preset name or custom seconds
 * Custom seconds must be >= 1 day (86400) and <= 10 years (315360000)
 */
export type PinDuration = PinDurationPreset | number

/**
 * Duration presets in seconds
 * Used for consensus-critical calculations
 */
export const PIN_DURATION_SECONDS = {
    permanent: 0, // 0 means never expires
    week: 7 * 24 * 60 * 60, // 604800
    month: 30 * 24 * 60 * 60, // 2592000
    quarter: 90 * 24 * 60 * 60, // 7776000
    year: 365 * 24 * 60 * 60, // 31536000
} as const

/**
 * Minimum and maximum custom duration limits
 * Prevents abuse while allowing flexibility
 */
export const PIN_DURATION_LIMITS = {
    /** Minimum custom duration: 1 day in seconds */
    minCustomSeconds: 86400,
    /** Maximum custom duration: 10 years in seconds */
    maxCustomSeconds: 315360000,
} as const

/**
 * Duration pricing multipliers relative to permanent storage
 * Lower values = discounts for shorter durations
 * 
 * Example: If permanent = 1.0 DEM/MB, then:
 * - week = 0.1 DEM/MB (90% discount)
 * - month = 0.25 DEM/MB (75% discount)
 * - quarter = 0.5 DEM/MB (50% discount)
 * - year = 0.8 DEM/MB (20% discount)
 * - permanent = 1.0 DEM/MB (full price)
 * 
 * NOTE: These are consensus-critical constants
 */
export const PIN_DURATION_PRICING = {
    /** 7 days: 10% of permanent price */
    week: 0.1,
    /** 30 days: 25% of permanent price */
    month: 0.25,
    /** 90 days: 50% of permanent price */
    quarter: 0.5,
    /** 365 days: 80% of permanent price */
    year: 0.8,
    /** Never expires: full price */
    permanent: 1.0,
} as const

/**
 * Result of duration validation
 */
export interface DurationValidationResult {
    /** Whether the duration is valid */
    valid: boolean
    /** Resolved duration in seconds (0 for permanent) */
    durationSeconds: number
    /** Unix timestamp when the pin would expire (undefined for permanent) */
    expiresAt?: number
    /** Pricing multiplier for this duration */
    pricingMultiplier: number
    /** Error message if invalid */
    errorMessage?: string
}

/**
 * Validate and resolve a pin duration
 * Converts presets to seconds and validates custom durations
 * 
 * @param duration - The duration to validate (preset name or custom seconds)
 * @param currentTimestamp - Current Unix timestamp for calculating expiresAt
 * @returns Validation result with resolved values
 */
export function validatePinDuration(
    duration: PinDuration,
    currentTimestamp: number,
): DurationValidationResult {
    // Handle preset durations
    if (typeof duration === "string") {
        const durationSeconds = PIN_DURATION_SECONDS[duration]
        const pricingMultiplier = PIN_DURATION_PRICING[duration]

        return {
            valid: true,
            durationSeconds,
            expiresAt: durationSeconds > 0 ? currentTimestamp + durationSeconds : undefined,
            pricingMultiplier,
        }
    }

    // Handle custom duration (number of seconds)
    if (typeof duration === "number") {
        // Validate range
        if (duration < PIN_DURATION_LIMITS.minCustomSeconds) {
            return {
                valid: false,
                durationSeconds: 0,
                pricingMultiplier: 0,
                errorMessage: `IPFS_INVALID_DURATION: Custom duration ${duration}s is below minimum ${PIN_DURATION_LIMITS.minCustomSeconds}s (1 day)`,
            }
        }

        if (duration > PIN_DURATION_LIMITS.maxCustomSeconds) {
            return {
                valid: false,
                durationSeconds: 0,
                pricingMultiplier: 0,
                errorMessage: `IPFS_INVALID_DURATION: Custom duration ${duration}s exceeds maximum ${PIN_DURATION_LIMITS.maxCustomSeconds}s (10 years)`,
            }
        }

        // Calculate pricing multiplier based on linear interpolation
        // Custom durations use a formula: multiplier = 0.1 + (duration / maxDuration) * 0.9
        // This ensures minimum 10% and scales up to 100% for 10-year durations
        const multiplier =
            0.1 + (duration / PIN_DURATION_LIMITS.maxCustomSeconds) * 0.9

        return {
            valid: true,
            durationSeconds: duration,
            expiresAt: currentTimestamp + duration,
            pricingMultiplier: Math.round(multiplier * 1000) / 1000, // Round to 3 decimals
        }
    }

    // Invalid type
    return {
        valid: false,
        durationSeconds: 0,
        pricingMultiplier: 0,
        errorMessage: `IPFS_INVALID_DURATION: Duration must be a preset name or number of seconds`,
    }
}

/**
 * Check if a pin has expired
 * 
 * @param pin - The pinned content to check
 * @param currentTimestamp - Current Unix timestamp
 * @returns true if the pin has expired, false otherwise
 */
export function isPinExpired(pin: PinnedContent, currentTimestamp: number): boolean {
    // No expiresAt means permanent pin
    if (!pin.expiresAt) {
        return false
    }
    return currentTimestamp >= pin.expiresAt
}

/**
 * Get all expired pins from an account's IPFS state
 * 
 * @param pins - Array of pinned content
 * @param currentTimestamp - Current Unix timestamp
 * @returns Array of expired pins
 */
export function getExpiredPins(pins: PinnedContent[], currentTimestamp: number): PinnedContent[] {
    return pins.filter((pin) => isPinExpired(pin, currentTimestamp))
}

/**
 * Calculate remaining time for a pin in human-readable format
 * 
 * @param pin - The pinned content
 * @param currentTimestamp - Current Unix timestamp
 * @returns Object with time remaining details
 */
export function getPinTimeRemaining(
    pin: PinnedContent,
    currentTimestamp: number,
): {
    isPermanent: boolean
    isExpired: boolean
    secondsRemaining: number
    humanReadable: string
} {
    if (!pin.expiresAt) {
        return {
            isPermanent: true,
            isExpired: false,
            secondsRemaining: Infinity,
            humanReadable: "permanent",
        }
    }

    const secondsRemaining = pin.expiresAt - currentTimestamp

    if (secondsRemaining <= 0) {
        return {
            isPermanent: false,
            isExpired: true,
            secondsRemaining: 0,
            humanReadable: "expired",
        }
    }

    // Format human readable
    const days = Math.floor(secondsRemaining / 86400)
    const hours = Math.floor((secondsRemaining % 86400) / 3600)
    const minutes = Math.floor((secondsRemaining % 3600) / 60)

    let humanReadable: string
    if (days > 0) {
        humanReadable = `${days}d ${hours}h`
    } else if (hours > 0) {
        humanReadable = `${hours}h ${minutes}m`
    } else {
        humanReadable = `${minutes}m`
    }

    return {
        isPermanent: false,
        isExpired: false,
        secondsRemaining,
        humanReadable,
    }
}
