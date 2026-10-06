/**
 * Token buckets for the tx topic: one per publisher for messages and
 * bytes, plus one global message bucket. Pure and clock-injected so it is
 * testable; the validator owns the single instance.
 */
export interface BucketSpec {
    ratePerSec: number
    burst: number
}

class TokenBucket {
    private tokens: number
    private updatedAt: number
    constructor(
        private readonly spec: BucketSpec,
        now: number,
    ) {
        this.tokens = spec.burst
        this.updatedAt = now
    }
    take(amount: number, now: number): boolean {
        const elapsed = Math.max(0, now - this.updatedAt) / 1000
        this.tokens = Math.min(
            this.spec.burst,
            this.tokens + elapsed * this.spec.ratePerSec,
        )
        this.updatedAt = now
        if (this.tokens < amount) return false
        this.tokens -= amount
        return true
    }
}

export type RateLimitVerdict = "ok" | "publisher_rate" | "publisher_bytes" | "global_rate"

export interface TxRateLimiterSpec {
    publisherMessages: BucketSpec
    publisherBytes: BucketSpec
    globalMessages: BucketSpec
    /** Idle publishers are forgotten after this long. */
    publisherTtlMs?: number
    maxPublishers?: number
}

export class TxRateLimiter {
    private readonly global: TokenBucket
    private readonly publishers = new Map<
        string,
        { messages: TokenBucket; bytes: TokenBucket; lastSeen: number }
    >()
    private readonly ttlMs: number
    private readonly maxPublishers: number

    constructor(
        private readonly spec: TxRateLimiterSpec,
        private readonly clock: () => number = Date.now,
    ) {
        this.global = new TokenBucket(spec.globalMessages, clock())
        this.ttlMs = spec.publisherTtlMs ?? 10 * 60_000
        this.maxPublishers = spec.maxPublishers ?? 4096
    }

    /**
     * Charge one message of `bytes` from `publisher`. Checks the cheapest
     * bucket first and charges nothing when any bucket refuses, so a
     * rejected message never drains the others.
     */
    admit(publisher: string, bytes: number): RateLimitVerdict {
        const now = this.clock()
        const key = publisher.toLowerCase()
        let entry = this.publishers.get(key)
        if (!entry) {
            if (this.publishers.size >= this.maxPublishers) this.evict(now)
            entry = {
                messages: new TokenBucket(this.spec.publisherMessages, now),
                bytes: new TokenBucket(this.spec.publisherBytes, now),
                lastSeen: now,
            }
            this.publishers.set(key, entry)
        }
        entry.lastSeen = now
        if (!entry.messages.take(1, now)) return "publisher_rate"
        if (!entry.bytes.take(bytes, now)) {
            entry.messages.take(-1, now)
            return "publisher_bytes"
        }
        if (!this.global.take(1, now)) {
            entry.messages.take(-1, now)
            entry.bytes.take(-bytes, now)
            return "global_rate"
        }
        return "ok"
    }

    private evict(now: number): void {
        for (const [key, entry] of this.publishers) {
            if (now - entry.lastSeen > this.ttlMs) this.publishers.delete(key)
        }
        if (this.publishers.size >= this.maxPublishers) {
            const oldest = [...this.publishers.entries()].sort(
                (a, b) => a[1].lastSeen - b[1].lastSeen,
            )[0]
            if (oldest) this.publishers.delete(oldest[0])
        }
    }

    size(): number {
        return this.publishers.size
    }
}
