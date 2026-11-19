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
 *
 * Records expire by timestamp, not by arrival: the verifier accepts
 * timestamps up to the skew on either side, so arrival order says nothing
 * about which record leaves the window first. Entries and floors are kept in
 * min-heaps by timestamp, so pruning takes exactly the expired ones and early
 * eviction takes the entry closest to expiry.
 */
export class ReplayCache {
    private readonly seen = new Map<string, Entry>()
    /** The entries of `seen`, earliest timestamp on top. */
    private readonly entryHeap = new MinHeap<Entry>()
    private readonly floors = new Map<string, number>()
    /**
     * Floors by value, earliest on top. A raise pushes the new value and
     * leaves the old one behind; an item whose value is no longer the
     * sender's floor is skipped when it surfaces.
     */
    private readonly floorHeap = new MinHeap<{ identity: string; timestamp: number; seq: number }>()
    /** Live records (entries plus a floor) per sender; a sender holds a slot while it has any. */
    private readonly records = new Map<string, number>()
    private seq = 0

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

        const entry: Entry = { key, identity, timestamp, seq: this.seq++ }
        this.seen.set(key, entry)
        this.entryHeap.push(entry)
        this.hold(identity)

        // The evicted entry's sender already holds a slot, so this never
        // needs a new one and never drops a live record.
        while (this.seen.size > this.maxEntries) this.evictEarliest()
        return "admitted"
    }

    private prune(now: number): void {
        const cutoff = now - this.windowMs
        for (let top = this.entryHeap.peek(); top && top.timestamp < cutoff; top = this.entryHeap.peek()) {
            this.entryHeap.pop()
            this.seen.delete(top.key)
            this.release(top.identity)
        }
        for (let top = this.floorHeap.peek(); top && top.timestamp < cutoff; top = this.floorHeap.peek()) {
            this.floorHeap.pop()
            if (this.floors.get(top.identity) !== top.timestamp) continue
            this.floors.delete(top.identity)
            this.release(top.identity)
        }
    }

    private evictEarliest(): void {
        const entry = this.entryHeap.pop()
        if (!entry) return
        this.seen.delete(entry.key)

        const { identity, timestamp } = entry
        const previous = this.floors.get(identity)
        if (previous === undefined) this.hold(identity)
        if (previous === undefined || timestamp > previous) {
            this.floors.set(identity, timestamp)
            this.floorHeap.push({ identity, timestamp, seq: this.seq++ })
            // Superseded values wait in the heap until they expire; rebuild
            // before they outnumber the floors, so the heap stays within a
            // constant of the floor count.
            if (this.floorHeap.size > 2 * this.floors.size + 64) {
                this.floorHeap.reset(
                    [...this.floors].map(([id, ts]) => ({
                        identity: id,
                        timestamp: ts,
                        seq: this.seq++,
                    })),
                )
            }
        }
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

interface Entry {
    key: string
    identity: string
    timestamp: number
    seq: number
}

/** Binary min-heap by timestamp, ties broken by insertion. */
class MinHeap<T extends { timestamp: number; seq: number }> {
    private items: T[] = []

    get size(): number {
        return this.items.length
    }

    peek(): T | undefined {
        return this.items[0]
    }

    push(item: T): void {
        const items = this.items
        items.push(item)
        let i = items.length - 1
        while (i > 0) {
            const parent = (i - 1) >> 1
            if (!less(items[i], items[parent])) break
            ;[items[i], items[parent]] = [items[parent], items[i]]
            i = parent
        }
    }

    pop(): T | undefined {
        const items = this.items
        const top = items[0]
        const last = items.pop()
        if (items.length > 0 && last !== undefined) {
            items[0] = last
            this.siftDown(0)
        }
        return top
    }

    reset(items: T[]): void {
        this.items = items
        for (let i = (items.length >> 1) - 1; i >= 0; i--) this.siftDown(i)
    }

    private siftDown(i: number): void {
        const items = this.items
        for (;;) {
            const left = 2 * i + 1
            const right = left + 1
            let smallest = i
            if (left < items.length && less(items[left], items[smallest])) smallest = left
            if (right < items.length && less(items[right], items[smallest])) smallest = right
            if (smallest === i) return
            ;[items[i], items[smallest]] = [items[smallest], items[i]]
            i = smallest
        }
    }
}

function less(a: { timestamp: number; seq: number }, b: { timestamp: number; seq: number }): boolean {
    return a.timestamp < b.timestamp || (a.timestamp === b.timestamp && a.seq < b.seq)
}
