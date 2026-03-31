/**
 * Rate Limiter
 *
 * Implements rate limiting using sliding window algorithm.
 * Tracks both IP-based and identity-based rate limits.
 */

import {
    RateLimitConfig,
    RateLimitEntry,
    RateLimitResult,
    RateLimitType,
} from "./types"

export class RateLimiter {
    private config: RateLimitConfig
    private ipLimits: Map<string, RateLimitEntry> = new Map()
    private identityLimits: Map<string, RateLimitEntry> = new Map()
    private cleanupTimer?: NodeJS.Timeout

    constructor(config: Partial<RateLimitConfig> = {}) {
        this.config = {
            enabled: config.enabled ?? true,
            maxConnectionsPerIP: config.maxConnectionsPerIP ?? 10,
            maxRequestsPerSecondPerIP: config.maxRequestsPerSecondPerIP ?? 100,
            maxRequestsPerSecondPerIdentity:
                config.maxRequestsPerSecondPerIdentity ?? 200,
            windowMs: config.windowMs ?? 1000,
            entryTTL: config.entryTTL ?? 60000,
            cleanupInterval: config.cleanupInterval ?? 10000,
        }

        // Start cleanup timer
        if (this.config.enabled) {
            this.startCleanup()
        }
    }

    /**
     * Check if a connection from an IP is allowed
     */
    checkConnection(ipAddress: string): RateLimitResult {
        if (!this.config.enabled) {
            return { allowed: true, currentCount: 0, limit: Infinity }
        }

        const entry = this.getOrCreateEntry(ipAddress, RateLimitType.IP)
        const now = Date.now()

        // Update last access
        entry.lastAccess = now

        // Check if blocked
        if (entry.blocked && entry.blockExpiry && now < entry.blockExpiry) {
            return {
                allowed: false,
                reason: "IP temporarily blocked",
                currentCount: entry.connections,
                limit: this.config.maxConnectionsPerIP,
                resetIn: entry.blockExpiry - now,
            }
        }

        // Clear block if expired
        if (entry.blocked && entry.blockExpiry && now >= entry.blockExpiry) {
            entry.blocked = false
            entry.blockExpiry = undefined
        }

        // Check connection limit
        if (entry.connections >= this.config.maxConnectionsPerIP) {
            // Block IP for 1 minute
            entry.blocked = true
            entry.blockExpiry = now + 60000

            return {
                allowed: false,
                reason: `Too many connections from IP (max ${this.config.maxConnectionsPerIP})`,
                currentCount: entry.connections,
                limit: this.config.maxConnectionsPerIP,
                resetIn: 60000,
            }
        }

        return {
            allowed: true,
            currentCount: entry.connections,
            limit: this.config.maxConnectionsPerIP,
        }
    }

    /**
     * Register a new connection from an IP
     */
    addConnection(ipAddress: string): void {
        if (!this.config.enabled) return

        const entry = this.getOrCreateEntry(ipAddress, RateLimitType.IP)
        entry.connections++
        entry.lastAccess = Date.now()
    }

    /**
     * Remove a connection from an IP
     */
    removeConnection(ipAddress: string): void {
        if (!this.config.enabled) return

        const entry = this.ipLimits.get(ipAddress)
        if (entry) {
            entry.connections = Math.max(0, entry.connections - 1)
            entry.lastAccess = Date.now()
        }
    }

    /**
     * Check if a request from an IP is allowed
     */
    checkIPRequest(ipAddress: string): RateLimitResult {
        if (!this.config.enabled) {
            return { allowed: true, currentCount: 0, limit: Infinity }
        }

        return this.checkRequest(
            ipAddress,
            RateLimitType.IP,
            this.config.maxRequestsPerSecondPerIP,
        )
    }

    /**
     * Check if a request from an authenticated identity is allowed
     */
    checkIdentityRequest(identity: string): RateLimitResult {
        if (!this.config.enabled) {
            return { allowed: true, currentCount: 0, limit: Infinity }
        }

        return this.checkRequest(
            identity,
            RateLimitType.IDENTITY,
            this.config.maxRequestsPerSecondPerIdentity,
        )
    }

    /**
     * Check request rate limit using sliding window
     */
    private checkRequest(
        key: string,
        type: RateLimitType,
        maxRequests: number,
    ): RateLimitResult {
        const entry = this.getOrCreateEntry(key, type)
        const now = Date.now()
        const windowStart = now - this.config.windowMs

        // Update last access
        entry.lastAccess = now

        // Check if blocked
        if (entry.blocked && entry.blockExpiry && now < entry.blockExpiry) {
            return {
                allowed: false,
                reason: `${type} temporarily blocked`,
                currentCount: entry.timestamps.length,
                limit: maxRequests,
                resetIn: entry.blockExpiry - now,
            }
        }

        // Clear block if expired
        if (entry.blocked && entry.blockExpiry && now >= entry.blockExpiry) {
            entry.blocked = false
            entry.blockExpiry = undefined
            entry.timestamps = []
        }

        // Remove timestamps outside the current window (sliding window)
        entry.timestamps = entry.timestamps.filter(ts => ts > windowStart)

        // Check if limit exceeded
        if (entry.timestamps.length >= maxRequests) {
            // Block for 1 minute
            entry.blocked = true
            entry.blockExpiry = now + 60000

            return {
                allowed: false,
                reason: `Rate limit exceeded for ${type} (max ${maxRequests} requests per second)`,
                currentCount: entry.timestamps.length,
                limit: maxRequests,
                resetIn: 60000,
            }
        }

        // Add current timestamp
        entry.timestamps.push(now)

        // Calculate reset time (when oldest timestamp expires)
        const oldestTimestamp = entry.timestamps[0]
        const resetIn = oldestTimestamp + this.config.windowMs - now

        return {
            allowed: true,
            currentCount: entry.timestamps.length,
            limit: maxRequests,
            resetIn: Math.max(0, resetIn),
        }
    }

    /**
     * Get or create a rate limit entry
     */
    private getOrCreateEntry(key: string, type: RateLimitType): RateLimitEntry {
        const map =
            type === RateLimitType.IP ? this.ipLimits : this.identityLimits

        let entry = map.get(key)
        if (!entry) {
            entry = {
                timestamps: [],
                connections: 0,
                lastAccess: Date.now(),
                blocked: false,
            }
            map.set(key, entry)
        }

        return entry
    }

    /**
     * Clean up expired entries
     */
    private cleanup(): void {
        const now = Date.now()
        const expiry = now - this.config.entryTTL

        // Clean IP limits
        for (const [ip, entry] of this.ipLimits.entries()) {
            if (entry.lastAccess < expiry && entry.connections === 0) {
                this.ipLimits.delete(ip)
            }
        }

        // Clean identity limits
        for (const [identity, entry] of this.identityLimits.entries()) {
            if (entry.lastAccess < expiry) {
                this.identityLimits.delete(identity)
            }
        }
    }

    /**
     * Start periodic cleanup
     */
    private startCleanup(): void {
        this.cleanupTimer = setInterval(() => {
            this.cleanup()
        }, this.config.cleanupInterval)
    }

    /**
     * Stop cleanup timer
     */
    stop(): void {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer)
            this.cleanupTimer = undefined
        }
    }

    /**
     * Get statistics
     */
    getStats(): {
        ipEntries: number
        identityEntries: number
        blockedIPs: number
        blockedIdentities: number
    } {
        let blockedIPs = 0
        for (const entry of this.ipLimits.values()) {
            if (entry.blocked) blockedIPs++
        }

        let blockedIdentities = 0
        for (const entry of this.identityLimits.values()) {
            if (entry.blocked) blockedIdentities++
        }

        return {
            ipEntries: this.ipLimits.size,
            identityEntries: this.identityLimits.size,
            blockedIPs,
            blockedIdentities,
        }
    }

    /**
     * Manually block an IP or identity
     */
    blockKey(key: string, type: RateLimitType, durationMs = 3600000): void {
        const entry = this.getOrCreateEntry(key, type)
        entry.blocked = true
        entry.blockExpiry = Date.now() + durationMs
    }

    /**
     * Manually unblock an IP or identity
     */
    unblockKey(key: string, type: RateLimitType): void {
        const map =
            type === RateLimitType.IP ? this.ipLimits : this.identityLimits
        const entry = map.get(key)
        if (entry) {
            entry.blocked = false
            entry.blockExpiry = undefined
        }
    }

    /**
     * Clear all rate limit data
     */
    clear(): void {
        this.ipLimits.clear()
        this.identityLimits.clear()
    }
}
