/**
 * In-process async concurrency gate (counting semaphore).
 *
 * Bounds how many callers may hold a slot at once (`maxConcurrent`). Callers
 * that arrive while all slots are taken wait in a bounded FIFO queue
 * (`maxQueue`). Each waiter is subject to a per-acquire timeout
 * (`acquireTimeoutMs`); if no slot frees before it elapses the waiter is
 * removed from the queue and rejected.
 *
 * Designed for a single-thread Bun/Node event loop: no real locks are needed,
 * correctness comes from careful ordering of the synchronous bookkeeping
 * performed inside `acquire`, `release` and the timeout callback.
 *
 * @example
 * const gate = new ConcurrencyGate({ maxConcurrent: 4, maxQueue: 16, acquireTimeoutMs: 250 })
 * const value = await gate.run(() => expensiveRead())
 */
export class ConcurrencyGate {
    private readonly maxConcurrent: number
    private readonly maxQueue: number
    private readonly acquireTimeoutMs: number

    /** Number of slots currently handed out (release functions outstanding). */
    private activeCount = 0

    /** FIFO list of waiters blocked on a free slot. */
    private readonly waiters: Waiter[] = []

    constructor(opts: {
        maxConcurrent: number
        maxQueue: number
        acquireTimeoutMs: number
    }) {
        if (!Number.isInteger(opts.maxConcurrent) || opts.maxConcurrent < 1) {
            throw new RangeError("maxConcurrent must be an integer >= 1")
        }
        if (!Number.isInteger(opts.maxQueue) || opts.maxQueue < 0) {
            throw new RangeError("maxQueue must be an integer >= 0")
        }
        if (
            !Number.isFinite(opts.acquireTimeoutMs) ||
            opts.acquireTimeoutMs < 0
        ) {
            throw new RangeError("acquireTimeoutMs must be a number >= 0")
        }
        this.maxConcurrent = opts.maxConcurrent
        this.maxQueue = opts.maxQueue
        this.acquireTimeoutMs = opts.acquireTimeoutMs
    }

    /** Slots currently held. */
    get active(): number {
        return this.activeCount
    }

    /** Callers currently waiting in the queue. */
    get queued(): number {
        return this.waiters.length
    }

    /**
     * Acquire a slot.
     *
     * Resolution semantics:
     * - If a slot is free (`active < maxConcurrent`) it is taken synchronously
     *   and the returned promise resolves on the next microtask with a release
     *   function.
     * - Otherwise, if the wait queue is already full (`queued >= maxQueue`) the
     *   promise rejects immediately with a {@link GateRejectedError} and the
     *   caller is NOT enqueued.
     * - Otherwise the caller is enqueued. It resolves with a release function
     *   when an earlier holder releases and hands its slot directly to this
     *   waiter (preserving FIFO order), or rejects with a
     *   {@link GateTimeoutError} once `acquireTimeoutMs` elapses, whichever
     *   happens first. The pending timer is always cleared on settle.
     *
     * @returns a release function. Calling it returns the slot. It is
     * idempotent: calling it more than once releases at most one slot.
     */
    acquire(): Promise<() => void> {
        // Fast path: a slot is free, take it without queueing.
        if (this.activeCount < this.maxConcurrent) {
            this.activeCount += 1
            return Promise.resolve(this.makeRelease())
        }

        // No slot free and the queue is saturated: reject without enqueueing.
        if (this.waiters.length >= this.maxQueue) {
            return Promise.reject(
                new GateRejectedError(
                    "concurrency gate queue is full; request rejected",
                ),
            )
        }

        // Enqueue and wait for a slot or the timeout, whichever comes first.
        return new Promise<() => void>((resolve, reject) => {
            const waiter: Waiter = {
                resolve,
                reject,
                timer: null,
            }

            waiter.timer = setTimeout(() => {
                // Remove self from the queue (still present => not yet served).
                const idx = this.waiters.indexOf(waiter)
                if (idx !== -1) {
                    this.waiters.splice(idx, 1)
                }
                waiter.timer = null
                reject(
                    new GateTimeoutError(
                        "timed out while waiting for a concurrency gate slot",
                    ),
                )
            }, this.acquireTimeoutMs)

            this.waiters.push(waiter)
        })
    }

    /**
     * Run `fn` while holding a slot, releasing it afterwards.
     *
     * Acquires a slot first; if acquisition rejects (timeout or queue full)
     * the returned promise rejects with that error and `fn` is never invoked.
     * Otherwise `fn` is awaited inside a try/finally so the slot is always
     * released, whether `fn` resolves or throws.
     */
    async run<T>(fn: () => Promise<T>): Promise<T> {
        const release = await this.acquire()
        try {
            return await fn()
        } finally {
            release()
        }
    }

    /**
     * Build an idempotent release function bound to one held slot.
     *
     * On release, if a waiter is queued the freed slot is handed directly to
     * the oldest waiter (its timer cleared, its promise resolved with a fresh
     * release) instead of decrementing then re-incrementing `activeCount`.
     * This keeps the slot count effectively unchanged across the handoff and
     * prevents a brand-new `acquire` from stealing the slot ahead of a waiter.
     */
    private makeRelease(): () => void {
        let released = false
        return () => {
            if (released) {
                return
            }
            released = true

            const next = this.waiters.shift()
            if (next) {
                if (next.timer !== null) {
                    clearTimeout(next.timer)
                    next.timer = null
                }
                // Slot is handed off: activeCount stays the same.
                next.resolve(this.makeRelease())
                return
            }

            // No waiter: actually free the slot.
            this.activeCount -= 1
        }
    }
}

interface Waiter {
    resolve: (release: () => void) => void
    reject: (err: Error) => void
    timer: ReturnType<typeof setTimeout> | null
}

/** Thrown when a queued acquire exceeds `acquireTimeoutMs`. */
export class GateTimeoutError extends Error {
    constructor(message = "concurrency gate acquire timed out") {
        super(message)
        this.name = "GateTimeoutError"
    }
}

/** Thrown when an acquire arrives and the wait queue is already full. */
export class GateRejectedError extends Error {
    constructor(message = "concurrency gate queue is full") {
        super(message)
        this.name = "GateRejectedError"
    }
}
