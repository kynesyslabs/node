export type AdmitResult = "admitted" | "replayed" | "full"

/**
 * Remembers which authenticated messages have been accepted while their
 * timestamps are still inside the freshness window, so each is accepted once.
 *
 * Memory is capped. When the entry cap forces an entry out before its window
 * ends, the sender's floor is raised to that entry's timestamp and anything
 * from that sender at or below it is refused, so an early eviction never
 * reopens a replay.
 *
 * Every record belongs to one sender and is checked against that sender only:
 * nothing one sender sends, and no timestamp it picks (the verifier accepts
 * them up to the skew ahead), moves the cutoff for anyone else. The number of
 * senders with live records is capped instead. A live record is never
 * dropped, so a sender that would need a new slot while every slot is live is
 * refused ("full") until one expires; senders that already hold a slot are
 * not affected.
 */
export class ReplayCache {
    private readonly seen = new Map<string, { identity: string; timestamp: number }>()
    /** Re-inserted on every raise, so the oldest-raised floor is first. */
    private readonly floors = new Map<string, number>()
    /** Live records (entries plus a floor) per sender; a sender holds a slot while it has any. */
    private readonly records = new Map<string, number>()

    constructor(
        private readonly windowMs: number,
        private readonly maxEntries = 100_000,
        private readonly maxSenders = 50_000,
    ) {}

    get size(): number {
        return this.seen.size
    }

    get senders(): number {
        return this.records.size
    }

    /**
     * "admitted" when this message is new and is now recorded; "replayed"
     * when it was seen before or falls under the sender's floor; "full" when
     * the sender holds no slot and none is free.
     */
    admit(
        identity: string,
        digest: string,
        timestamp: number,
        now = Date.now(),
    ): AdmitResult {
        this.prune(now)

        const floor = this.floors.get(identity)
        if (floor !== undefined && timestamp <= floor) return "replayed"

        const key = identity + ":" + digest
        if (this.seen.has(key)) return "replayed"
        if (!this.records.has(identity) && this.records.size >= this.maxSenders) {
            return "full"
        }

        this.seen.set(key, { identity, timestamp })
        this.hold(identity)

        // The evicted entry's sender already holds a slot, so this never
        // needs a new one and never drops a live record.
        while (this.seen.size > this.maxEntries) this.evictOldest()
        return "admitted"
    }

    /** Entries go in roughly in timestamp order, so pruning stops at the first live one. */
    private prune(now: number): void {
        const cutoff = now - this.windowMs
        for (const [key, entry] of this.seen) {
            if (entry.timestamp >= cutoff) break
            this.seen.delete(key)
            this.release(entry.identity)
        }
        for (const [identity, floor] of this.floors) {
            if (floor >= cutoff) break
            this.floors.delete(identity)
            this.release(identity)
        }
    }

    private evictOldest(): void {
        const first = this.seen.entries().next()
        if (first.done) return
        const [key, { identity, timestamp }] = first.value
        this.seen.delete(key)

        const previous = this.floors.get(identity)
        if (previous === undefined) this.hold(identity)
        this.floors.delete(identity)
        this.floors.set(identity, Math.max(previous ?? -Infinity, timestamp))
        this.release(identity)
    }

    private hold(identity: string): void {
        this.records.set(identity, (this.records.get(identity) ?? 0) + 1)
    }

    private release(identity: string): void {
        const left = (this.records.get(identity) ?? 0) - 1
        if (left > 0) this.records.set(identity, left)
        else this.records.delete(identity)
    }
}
