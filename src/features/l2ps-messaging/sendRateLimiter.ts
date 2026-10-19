/** How long a full bucket may sit unused before its entry is dropped. */
const IDLE_EVICT_MS = 60_000
/** Minimum gap between two sweeps of the table. */
const SWEEP_INTERVAL_MS = 10_000

export interface SendRateLimiterOptions {
    /** Tokens added per second. 0 or less turns the limiter off. */
    ratePerSec: number
    /** Bucket size, the most a key can send at once. */
    burst: number
    now?: () => number
}

/** `retryAfterMs` is 0 when the send is allowed. */
export interface SendDecision {
    allowed: boolean
    retryAfterMs: number
}

interface Bucket {
    tokens: number
    updatedAt: number
}

/**
 * A token bucket per sender key. Anyone can register a key, so the relay
 * limits each one on its own; entries leave the table once their bucket is
 * full again and has been idle, which bounds it by the keys active in the
 * last minute rather than every key ever seen.
 */
export class SendRateLimiter {
    private readonly buckets = new Map<string, Bucket>()
    private readonly now: () => number
    private lastSweep = 0

    constructor(private readonly opts: SendRateLimiterOptions) {
        this.now = opts.now ?? Date.now
    }

    take(key: string): SendDecision {
        const { ratePerSec, burst } = this.opts
        if (ratePerSec <= 0) return { allowed: true, retryAfterMs: 0 }

        const now = this.now()
        this.sweep(now)

        const bucket = this.buckets.get(key) ?? { tokens: burst, updatedAt: now }
        bucket.tokens = this.refilled(bucket, now)
        bucket.updatedAt = now
        this.buckets.set(key, bucket)

        if (bucket.tokens < 1) {
            return { allowed: false, retryAfterMs: Math.ceil(((1 - bucket.tokens) / ratePerSec) * 1000) }
        }
        bucket.tokens -= 1
        return { allowed: true, retryAfterMs: 0 }
    }

    /** Keys currently tracked; for tests and diagnostics. */
    get size(): number {
        return this.buckets.size
    }

    private refilled(bucket: Bucket, now: number): number {
        const elapsedSec = Math.max(0, now - bucket.updatedAt) / 1000
        return Math.min(this.opts.burst, bucket.tokens + elapsedSec * this.opts.ratePerSec)
    }

    private sweep(now: number): void {
        if (now - this.lastSweep < SWEEP_INTERVAL_MS) return
        this.lastSweep = now
        for (const [key, bucket] of this.buckets) {
            const idle = now - bucket.updatedAt >= IDLE_EVICT_MS
            if (idle && this.refilled(bucket, now) >= this.opts.burst) this.buckets.delete(key)
        }
    }
}
