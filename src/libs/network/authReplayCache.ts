/**
 * Body-bound auth messages already accepted inside the timestamp window.
 *
 * A captured body-bound request stays valid for the whole ±window, so without
 * this it could be replayed unchanged (same headers, same body) until its
 * timestamp ages out. The key is the signed message, not the signature
 * bytes: a second encoding or a second valid signature of the same message
 * is the same request.
 *
 * Memory is bounded. When full, the entry closest to expiry is dropped rather
 * than new requests refused, so a flood of signed requests cannot stop peers
 * from talking; it can at best reopen replay for the shortest remaining
 * windows, and the IP rate limits make that flood expensive.
 */
export class SeenAuthMessages {
    private readonly expiries = new Map<string, number>()
    // Expiry follows the signer's timestamp, not arrival, so insertion order
    // says nothing about which entry expires first: a heap keeps every
    // claim O(log n), even with the cache full of live entries.
    private readonly heap: HeapEntry[] = []
    private seq = 0

    constructor(private readonly maxEntries: number) {}

    /**
     * Records `message` as used until `expiresAt`. False when it was
     * already used and has not expired: the request is a replay.
     */
    claim(message: string, expiresAt: number, now = Date.now()): boolean {
        this.prune(now)
        if (this.expiries.has(message)) return false
        while (this.expiries.size >= this.maxEntries) {
            this.dropHead()
        }
        this.expiries.set(message, expiresAt)
        this.push({ expiresAt, seq: this.seq++, message })
        return true
    }

    get size(): number {
        return this.expiries.size
    }

    clear(): void {
        this.expiries.clear()
        this.heap.length = 0
    }

    private prune(now: number): void {
        while (this.heap.length > 0 && this.heap[0].expiresAt < now) {
            this.dropHead()
        }
    }

    private dropHead(): void {
        const head = this.pop()
        if (head && this.expiries.get(head.message) === head.expiresAt) {
            this.expiries.delete(head.message)
        }
    }

    private push(entry: HeapEntry): void {
        const heap = this.heap
        heap.push(entry)
        let i = heap.length - 1
        while (i > 0) {
            const parent = (i - 1) >> 1
            if (!before(heap[i], heap[parent])) break
            ;[heap[i], heap[parent]] = [heap[parent], heap[i]]
            i = parent
        }
    }

    private pop(): HeapEntry | undefined {
        const heap = this.heap
        const top = heap[0]
        const last = heap.pop()
        if (heap.length === 0 || last === undefined) return top
        heap[0] = last
        let i = 0
        for (;;) {
            const left = 2 * i + 1
            const right = left + 1
            let least = i
            if (left < heap.length && before(heap[left], heap[least])) least = left
            if (right < heap.length && before(heap[right], heap[least])) least = right
            if (least === i) return top
            ;[heap[i], heap[least]] = [heap[least], heap[i]]
            i = least
        }
    }
}

interface HeapEntry {
    expiresAt: number
    /** Ties on expiry go to the older claim. */
    seq: number
    message: string
}

function before(a: HeapEntry, b: HeapEntry): boolean {
    return a.expiresAt < b.expiresAt || (a.expiresAt === b.expiresAt && a.seq < b.seq)
}
