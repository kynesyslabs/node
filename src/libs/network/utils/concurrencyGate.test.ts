import { describe, expect, it, jest } from "bun:test"

import {
    ConcurrencyGate,
    GateRejectedError,
    GateTimeoutError,
} from "./concurrencyGate"

describe("ConcurrencyGate", () => {
    describe("constructor validation", () => {
        it("rejects maxConcurrent < 1", () => {
            expect(
                () =>
                    new ConcurrencyGate({
                        maxConcurrent: 0,
                        maxQueue: 1,
                        acquireTimeoutMs: 10,
                    }),
            ).toThrow(RangeError)
        })

        it("rejects negative maxQueue", () => {
            expect(
                () =>
                    new ConcurrencyGate({
                        maxConcurrent: 1,
                        maxQueue: -1,
                        acquireTimeoutMs: 10,
                    }),
            ).toThrow(RangeError)
        })

        it("rejects negative acquireTimeoutMs", () => {
            expect(
                () =>
                    new ConcurrencyGate({
                        maxConcurrent: 1,
                        maxQueue: 0,
                        acquireTimeoutMs: -5,
                    }),
            ).toThrow(RangeError)
        })

        it("accepts maxQueue = 0 and acquireTimeoutMs = 0", () => {
            expect(
                () =>
                    new ConcurrencyGate({
                        maxConcurrent: 1,
                        maxQueue: 0,
                        acquireTimeoutMs: 0,
                    }),
            ).not.toThrow()
        })
    })

    describe("immediate acquire under capacity", () => {
        it("hands out up to maxConcurrent slots without waiting", async () => {
            const gate = new ConcurrencyGate({
                maxConcurrent: 2,
                maxQueue: 4,
                acquireTimeoutMs: 1000,
            })

            const r1 = await gate.acquire()
            const r2 = await gate.acquire()

            expect(typeof r1).toBe("function")
            expect(typeof r2).toBe("function")
            expect(gate.active).toBe(2)
            expect(gate.queued).toBe(0)

            r1()
            r2()
            expect(gate.active).toBe(0)
        })
    })

    describe("queueing past capacity", () => {
        it("queues the overflow caller then serves it on release", async () => {
            const gate = new ConcurrencyGate({
                maxConcurrent: 1,
                maxQueue: 4,
                acquireTimeoutMs: 1000,
            })

            const r1 = await gate.acquire()
            expect(gate.active).toBe(1)

            const pending = gate.acquire()
            // Allow the pending promise's executor to enqueue.
            await Promise.resolve()
            expect(gate.queued).toBe(1)
            expect(gate.active).toBe(1)

            // Release the held slot; it is handed directly to the waiter.
            r1()
            const r2 = await pending
            expect(gate.queued).toBe(0)
            expect(gate.active).toBe(1)

            r2()
            expect(gate.active).toBe(0)
        })

        it("serves multiple waiters in FIFO order", async () => {
            const gate = new ConcurrencyGate({
                maxConcurrent: 1,
                maxQueue: 8,
                acquireTimeoutMs: 1000,
            })

            const order: number[] = []
            const first = await gate.acquire()

            // Enqueue three waiters in a known order.
            const p1 = gate.acquire().then((rel) => {
                order.push(1)
                return rel
            })
            const p2 = gate.acquire().then((rel) => {
                order.push(2)
                return rel
            })
            const p3 = gate.acquire().then((rel) => {
                order.push(3)
                return rel
            })

            await Promise.resolve()
            expect(gate.queued).toBe(3)

            // Drain the chain: each release hands the slot to the next waiter.
            first()
            ;(await p1)()
            ;(await p2)()
            ;(await p3)()

            expect(order).toEqual([1, 2, 3])
            expect(gate.active).toBe(0)
            expect(gate.queued).toBe(0)
        })
    })

    describe("queue-full rejection", () => {
        it("rejects with GateRejectedError without enqueueing", async () => {
            const gate = new ConcurrencyGate({
                maxConcurrent: 1,
                maxQueue: 1,
                acquireTimeoutMs: 1000,
            })

            const r1 = await gate.acquire()
            const queued = gate.acquire() // fills the single queue slot
            await Promise.resolve()
            expect(gate.queued).toBe(1)

            // Third acquire: no slot, queue full => immediate rejection.
            await expect(gate.acquire()).rejects.toBeInstanceOf(
                GateRejectedError,
            )
            expect(gate.queued).toBe(1)

            // Cleanup so the queued promise settles.
            r1()
            ;(await queued)()
        })
    })

    describe("acquire timeout", () => {
        it("rejects a waiter with GateTimeoutError after acquireTimeoutMs", async () => {
            // Real (short) timer rather than fake timers: bun:test's fake-timer
            // support does not reliably drive setTimeout callbacks, so a small
            // real wait keeps this deterministic without flaking.
            const gate = new ConcurrencyGate({
                maxConcurrent: 1,
                maxQueue: 4,
                acquireTimeoutMs: 30,
            })

            const r1 = await gate.acquire()
            expect(gate.active).toBe(1)

            const pending = gate.acquire()
            // Pre-empt an unhandled-rejection warning by attaching a catch now;
            // the real assertion happens after the wait below.
            pending.catch(() => {})

            // Let the executor run and enqueue the waiter.
            await Promise.resolve()
            expect(gate.queued).toBe(1)

            // Wait past the acquire timeout; the waiter removes itself + rejects.
            await new Promise(resolve => setTimeout(resolve, 60))
            await expect(pending).rejects.toBeInstanceOf(GateTimeoutError)

            expect(gate.queued).toBe(0)
            // The held slot is untouched by the timeout.
            expect(gate.active).toBe(1)

            r1()
            expect(gate.active).toBe(0)
        })
    })

    describe("release idempotency", () => {
        it("releases only one slot when called twice", async () => {
            const gate = new ConcurrencyGate({
                maxConcurrent: 2,
                maxQueue: 4,
                acquireTimeoutMs: 1000,
            })

            const r1 = await gate.acquire()
            const r2 = await gate.acquire()
            expect(gate.active).toBe(2)

            r1()
            r1() // second call is a no-op
            expect(gate.active).toBe(1)

            r2()
            expect(gate.active).toBe(0)
        })

        it("does not double-serve a waiter on a double release", async () => {
            const gate = new ConcurrencyGate({
                maxConcurrent: 1,
                maxQueue: 4,
                acquireTimeoutMs: 1000,
            })

            const r1 = await gate.acquire()
            const pending = gate.acquire()
            await Promise.resolve()
            expect(gate.queued).toBe(1)

            r1()
            const r2 = await pending
            r1() // idempotent: must NOT free the slot now held by the waiter

            expect(gate.active).toBe(1)
            expect(gate.queued).toBe(0)

            r2()
            expect(gate.active).toBe(0)
        })
    })

    describe("run()", () => {
        it("releases the slot on success and returns the value", async () => {
            const gate = new ConcurrencyGate({
                maxConcurrent: 1,
                maxQueue: 4,
                acquireTimeoutMs: 1000,
            })

            const result = await gate.run(async () => {
                expect(gate.active).toBe(1)
                return 42
            })

            expect(result).toBe(42)
            expect(gate.active).toBe(0)
        })

        it("releases the slot when fn throws and propagates the error", async () => {
            const gate = new ConcurrencyGate({
                maxConcurrent: 1,
                maxQueue: 4,
                acquireTimeoutMs: 1000,
            })

            const boom = new Error("boom")
            await expect(
                gate.run(async () => {
                    throw boom
                }),
            ).rejects.toBe(boom)

            expect(gate.active).toBe(0)
        })

        it("never invokes fn when acquire is rejected (queue full)", async () => {
            const gate = new ConcurrencyGate({
                maxConcurrent: 1,
                maxQueue: 0,
                acquireTimeoutMs: 1000,
            })

            const r1 = await gate.acquire()
            const fn = jest.fn(async () => "unreachable")

            await expect(gate.run(fn)).rejects.toBeInstanceOf(GateRejectedError)
            expect(fn).not.toHaveBeenCalled()

            r1()
        })
    })

    describe("counters", () => {
        it("tracks active and queued through a full cycle", async () => {
            const gate = new ConcurrencyGate({
                maxConcurrent: 2,
                maxQueue: 4,
                acquireTimeoutMs: 1000,
            })

            expect(gate.active).toBe(0)
            expect(gate.queued).toBe(0)

            const r1 = await gate.acquire()
            const r2 = await gate.acquire()
            expect(gate.active).toBe(2)

            const p3 = gate.acquire()
            const p4 = gate.acquire()
            await Promise.resolve()
            expect(gate.queued).toBe(2)
            expect(gate.active).toBe(2)

            r1()
            const r3 = await p3
            expect(gate.queued).toBe(1)
            expect(gate.active).toBe(2)

            r2()
            const r4 = await p4
            expect(gate.queued).toBe(0)
            expect(gate.active).toBe(2)

            r3()
            r4()
            expect(gate.active).toBe(0)
            expect(gate.queued).toBe(0)
        })
    })
})
