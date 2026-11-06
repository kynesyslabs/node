/**
 * Remembers which authenticated messages have been accepted while their
 * timestamps are still inside the freshness window, so each is accepted once.
 *
 * Memory is capped. When the cap forces an entry out before its window ends,
 * the sender's floor is raised to that entry's timestamp and anything from
 * that sender at or below it is refused, so an early eviction never reopens
 * a replay. Floors are per sender: one peer flooding the cache only raises
 * its own. When the floor cap forces a floor out while it is still live, its
 * value moves into one floor shared by every sender instead of being lost:
 * under that much pressure delayed messages are refused, never replayed.
 */
export class ReplayCache {
    private readonly seen = new Map<string, { identity: string; timestamp: number }>()
    private readonly floors = new Map<string, number>()
    private sharedFloor = -Infinity

    constructor(
        private readonly windowMs: number,
        private readonly maxEntries = 100_000,
        private readonly maxFloors = 50_000,
    ) {}

    get size(): number {
        return this.seen.size
    }

    /**
     * True when this message is new and is now recorded; false when it was
     * seen before or falls under the sender's floor.
     */
    admit(
        identity: string,
        digest: string,
        timestamp: number,
        now = Date.now(),
    ): boolean {
        this.prune(now)

        if (timestamp <= this.sharedFloor) return false
        const floor = this.floors.get(identity)
        if (floor !== undefined && timestamp <= floor) return false

        const key = identity + ":" + digest
        if (this.seen.has(key)) return false
        this.seen.set(key, { identity, timestamp })

        while (this.seen.size > this.maxEntries) this.evictOldest()
        return true
    }

    /** Entries go in roughly in timestamp order, so pruning stops at the first live one. */
    private prune(now: number): void {
        const cutoff = now - this.windowMs
        for (const [key, entry] of this.seen) {
            if (entry.timestamp >= cutoff) break
            this.seen.delete(key)
        }
        for (const [identity, floor] of this.floors) {
            if (floor >= cutoff) break
            this.floors.delete(identity)
        }
    }

    private evictOldest(): void {
        const first = this.seen.entries().next()
        if (first.done) return
        const [key, { identity, timestamp }] = first.value
        this.seen.delete(key)

        const floor = Math.max(this.floors.get(identity) ?? -Infinity, timestamp)
        this.floors.delete(identity)
        this.floors.set(identity, floor)
        while (this.floors.size > this.maxFloors) {
            const oldest = this.floors.entries().next()
            if (oldest.done) break
            const [dropped, droppedFloor] = oldest.value
            this.floors.delete(dropped)
            this.sharedFloor = Math.max(this.sharedFloor, droppedFloor)
        }
    }
}
