/**
 * Rate Limiting Types
 *
 * Provides types for rate limiting configuration and state.
 */

export interface RateLimitConfig {
    /**
     * Enable rate limiting
     */
    enabled: boolean

    /**
     * Maximum connections per IP address
     * Default: 10
     */
    maxConnectionsPerIP: number

    /**
     * Maximum requests per second per IP
     * Default: 100
     */
    maxRequestsPerSecondPerIP: number

    /**
     * Maximum requests per second per authenticated identity
     * Default: 200
     */
    maxRequestsPerSecondPerIdentity: number

    /**
     * Time window for rate limiting in milliseconds
     * Default: 1000 (1 second)
     */
    windowMs: number

    /**
     * How long to keep rate limit entries in memory (milliseconds)
     * Default: 60000 (1 minute)
     */
    entryTTL: number

    /**
     * How often to clean up expired entries (milliseconds)
     * Default: 10000 (10 seconds)
     */
    cleanupInterval: number
}

export interface RateLimitEntry {
    /**
     * Timestamps of requests in current window
     */
    timestamps: number[]

    /**
     * Number of active connections (for IP-based tracking)
     */
    connections: number

    /**
     * Last access time (for cleanup)
     */
    lastAccess: number

    /**
     * Whether this entry is currently blocked
     */
    blocked: boolean

    /**
     * When the block expires
     */
    blockExpiry?: number
}

export interface RateLimitResult {
    /**
     * Whether the request is allowed
     */
    allowed: boolean

    /**
     * Reason for denial (if allowed = false)
     */
    reason?: string

    /**
     * Current request count
     */
    currentCount: number

    /**
     * Maximum allowed requests
     */
    limit: number

    /**
     * Time until reset (milliseconds)
     */
    resetIn?: number
}

export enum RateLimitType {
    IP = "ip",
    IDENTITY = "identity",
}
