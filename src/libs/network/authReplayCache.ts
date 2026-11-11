/**
 * Body-bound auth messages already accepted inside the timestamp window.
 *
 * A captured body-bound request stays valid for the whole ±window, so without
 * this it could be replayed unchanged (same headers, same body) until its
 * timestamp ages out. The key is the signed message, not the signature
 * bytes: a second encoding or a second valid signature of the same message
 * is the same request.
 *
 * Memory is bounded. When full, the oldest entry is dropped rather than new
 * requests refused, so a flood of signed requests cannot stop peers from
 * talking; it can at best reopen replay for the oldest entries, and the IP
 * rate limits make that flood expensive.
 */
export class SeenAuthMessages {
    private readonly expiries = new Map<string, number>()

    constructor(private readonly maxEntries: number) {}

    /**
     * Records `message` as used until `expiresAt`. False when it was
     * already used and has not expired: the request is a replay.
     */
    claim(message: string, expiresAt: number, now = Date.now()): boolean {
        this.prune(now)
        const seenUntil = this.expiries.get(message)
        if (seenUntil !== undefined && seenUntil >= now) return false
        if (seenUntil !== undefined) this.expiries.delete(message)
        if (this.expiries.size >= this.maxEntries) this.sweepExpired(now)
        while (this.expiries.size >= this.maxEntries) {
            const oldest = this.expiries.keys().next().value as string
            this.expiries.delete(oldest)
        }
        this.expiries.set(message, expiresAt)
        return true
    }

    get size(): number {
        return this.expiries.size
    }

    clear(): void {
        this.expiries.clear()
    }

    // Insertion order roughly follows expiry, so expired entries are taken
    // off the head; the few left behind a later one go when the bound is hit.
    private prune(now: number): void {
        for (const [message, expiresAt] of this.expiries) {
            if (expiresAt >= now) return
            this.expiries.delete(message)
        }
    }

    // Evicting a live entry reopens its replay, so every expired one goes
    // first. A full scan, but only when the bound is hit.
    private sweepExpired(now: number): void {
        for (const [message, expiresAt] of this.expiries) {
            if (expiresAt < now) this.expiries.delete(message)
        }
    }
}
