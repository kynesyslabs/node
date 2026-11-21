// DbProbe (dbProbe.ts): what demos_db_up reports for a database that answers,
// fails, or never answers, that a hung probe never stalls the next tick, that a
// timed-out probe is aborted and replaced once it has given up its connection,
// and that a stopped probe reports nothing more.
import { describe, expect, it, spyOn } from "bun:test"
import { DbProbe } from "./dbProbe"

const TIMEOUT_MS = 50

function harness(
    probe: (signal: AbortSignal) => Promise<unknown>,
    intervalMs = 10_000,
) {
    const reports: Array<[0 | 1, number | null]> = []
    const changes: Array<[0 | 1, string | null]> = []
    let calls = 0
    const db = new DbProbe({
        probe: signal => {
            calls++
            return probe(signal)
        },
        report: (up, seconds) => reports.push([up, seconds]),
        onChange: (up, reason) => changes.push([up, reason]),
        timeoutMs: TIMEOUT_MS,
        intervalMs,
    })
    return { db, reports, changes, calls: () => calls }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe("DbProbe", () => {
    it("reports 1 and the probe duration when the query answers", async () => {
        const h = harness(() => Promise.resolve([{ "?column?": 1 }]))
        await h.db.tick()
        expect(h.reports).toHaveLength(1)
        const [up, seconds] = h.reports[0]
        expect(up).toBe(1)
        expect(typeof seconds).toBe("number")
        expect(seconds ?? -1).toBeGreaterThanOrEqual(0)
        expect(seconds ?? Infinity).toBeLessThan(TIMEOUT_MS / 1000)
        // A healthy first result is not worth a log line.
        expect(h.changes).toEqual([])
    })

    it("reports 0 when the query rejects", async () => {
        const h = harness(() =>
            Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:5332")),
        )
        await h.db.tick()
        expect(h.reports).toEqual([[0, null]])
        expect(h.changes).toEqual([[0, "connect ECONNREFUSED 127.0.0.1:5332"]])
    })

    it("reports 0 when the probe throws before returning a promise", async () => {
        const h = harness(() => {
            throw new Error("the DataSource is not initialized")
        })
        await h.db.tick()
        expect(h.reports).toEqual([[0, null]])
        expect(h.changes).toEqual([[0, "the DataSource is not initialized"]])
    })

    it("reports 0 after the timeout for a query that never returns, and the next tick does not wait for it", async () => {
        const stuck: { answer?: () => void } = {}
        let hang = true
        const h = harness(() =>
            hang
                ? new Promise<void>(resolve => {
                      stuck.answer = resolve
                  })
                : Promise.resolve(),
        )

        const started = performance.now()
        await h.db.tick()
        const elapsed = performance.now() - started
        expect(elapsed).toBeGreaterThanOrEqual(TIMEOUT_MS - 5)
        expect(elapsed).toBeLessThan(TIMEOUT_MS * 10)
        expect(h.reports).toEqual([[0, null]])
        expect(h.changes[0][0]).toBe(0)
        expect(h.changes[0][1]).toContain(`within ${TIMEOUT_MS} ms`)

        // The first query is still pending. The next tick reports 0 at once
        // and does not queue a second query on the pool.
        const next = performance.now()
        await h.db.tick()
        expect(performance.now() - next).toBeLessThan(TIMEOUT_MS)
        expect(h.reports).toEqual([
            [0, null],
            [0, null],
        ])
        expect(h.calls()).toBe(1)
        // Still down for the same reason (the first probe still has no
        // answer): no second log line.
        expect(h.changes).toHaveLength(1)

        // Once the stuck query settles, the next tick probes again.
        hang = false
        stuck.answer?.()
        await sleep(0)
        await h.db.tick()
        expect(h.calls()).toBe(2)
        expect(h.reports[2][0]).toBe(1)
        expect(h.changes).toHaveLength(2)
        expect(h.changes[1]).toEqual([1, null])
    })

    it("goes back to 1 when the database answers again, logging each change once", async () => {
        let down = false
        const h = harness(() =>
            down
                ? Promise.reject(new Error("Connection terminated"))
                : Promise.resolve(),
        )
        await h.db.tick()
        down = true
        await h.db.tick()
        await h.db.tick()
        down = false
        await h.db.tick()
        expect(h.reports.map(r => r[0])).toEqual([1, 0, 0, 1])
        expect(h.changes).toEqual([
            [0, "Connection terminated"],
            [1, null],
        ])
    })

    it("logs a new failure reason while still down, once per reason, and clears it on recovery", async () => {
        // Runbook step 1 triages on the latest `[DB] Postgres probe failed`
        // line, so a timeout followed by ECONNREFUSED (Postgres restarted)
        // must log both. Before the fix only the first reason was logged:
        // [[0, "no answer within 50 ms"], [1, null]].
        const refused = "connect ECONNREFUSED 127.0.0.1:5332"
        let mode: "hang" | "refused" | "up" = "hang"
        const h = harness(signal => {
            if (mode === "up") return Promise.resolve()
            if (mode === "refused") return Promise.reject(new Error(refused))
            // Gives up its connection on abort, as pingDatabase does.
            return new Promise((_, reject) =>
                signal.addEventListener("abort", () => reject(signal.reason)),
            )
        })
        const step = async (next: typeof mode) => {
            mode = next
            await h.db.tick()
            // Let an aborted probe settle so the next tick probes again.
            await sleep(0)
        }

        for (const next of [
            "hang",
            "hang",
            "refused",
            "refused",
            "up",
        ] as const) {
            await step(next)
        }
        expect(h.calls()).toBe(5)
        expect(h.reports.map(r => r[0])).toEqual([0, 0, 0, 0, 1])
        expect(h.changes).toEqual([
            [0, `no answer within ${TIMEOUT_MS} ms`],
            [0, refused],
            [1, null],
        ])

        // The recovery cleared the stored reason: the same error logs again.
        await step("refused")
        expect(h.changes).toHaveLength(4)
        expect(h.changes[3]).toEqual([0, refused])
    })

    it("start() probes at once, and a second start() adds no second tick or timer", async () => {
        const intervals = spyOn(globalThis, "setInterval")
        // No interval can elapse during this test: only start() probes.
        const h = harness(() => Promise.resolve(), 60_000)
        try {
            h.db.start()
            h.db.start()
            expect(intervals).toHaveBeenCalledTimes(1)
            await sleep(5)
            expect(h.calls()).toBe(1)
            // A second tick would have reported 0 (the first probe was in flight).
            expect(h.reports.map(r => r[0])).toEqual([1])
        } finally {
            h.db.stop()
            intervals.mockRestore()
        }
    })

    it("start() probes on every interval; stop() ends it", async () => {
        const h = harness(() => Promise.resolve(), 20)
        h.db.start()
        await sleep(75)
        h.db.stop()
        const afterStop = h.calls()
        // About 4 (one at start, one every 20 ms); timers run late on a loaded host.
        expect(afterStop).toBeGreaterThanOrEqual(2)
        expect(afterStop).toBeLessThanOrEqual(6)
        await sleep(60)
        expect(h.calls()).toBe(afterStop)
        expect(h.reports.every(r => r[0] === 1)).toBe(true)
    })

    it("aborts a probe that times out, and later ticks probe again and report 1 once the database answers", async () => {
        // Like pingDatabase on a half-open connection: the query never gets an
        // answer; on abort the probe gives up its connection and rejects.
        const signals: AbortSignal[] = []
        let hang = true
        const h = harness(signal => {
            signals.push(signal)
            if (!hang) return Promise.resolve()
            return new Promise((_, reject) =>
                signal?.addEventListener("abort", () => reject(signal.reason)),
            )
        })

        await h.db.tick()
        expect(h.reports).toEqual([[0, null]])

        // The database is back. Before the fix the first query held the probe
        // forever: {"calls":1,"reports":[0,0,0]}.
        hang = false
        await h.db.tick()
        await h.db.tick()
        expect(h.calls()).toBeGreaterThanOrEqual(2)
        expect(h.reports.at(-1)).toEqual([1, expect.any(Number)])
        expect(h.changes.at(-1)).toEqual([1, null])
        // The timeout aborted the first probe's signal, and only that one.
        expect(signals[0]?.aborted).toBe(true)
        expect(signals.slice(1).every(s => !s.aborted)).toBe(true)
    })

    it("starts no second query while an aborted probe has not finished giving up its connection", async () => {
        const pending: { release?: () => void } = {}
        let first = true
        const h = harness(signal => {
            if (!first) return Promise.resolve()
            first = false
            // On abort, the release takes a while; the probe settles after it.
            return new Promise((_, reject) =>
                signal?.addEventListener("abort", () => {
                    pending.release = () => reject(signal.reason)
                }),
            )
        })

        await h.db.tick()
        expect(pending.release).toBeDefined()
        await h.db.tick()
        await sleep(TIMEOUT_MS * 2)
        await h.db.tick()
        expect(h.calls()).toBe(1)
        expect(h.reports.map(r => r[0])).toEqual([0, 0, 0])

        pending.release?.()
        await sleep(0)
        await h.db.tick()
        expect(h.calls()).toBe(2)
        expect(h.reports.at(-1)?.[0]).toBe(1)
    })

    it("a stopped probe's late result does not overwrite its replacement's", async () => {
        const gauge: Array<[string, 0 | 1]> = []
        const changes: string[] = []
        const pending: { fail?: (error: Error) => void } = {}
        const make = (
            name: string,
            probe: (signal: AbortSignal) => Promise<unknown>,
        ) =>
            new DbProbe({
                probe,
                report: up => gauge.push([name, up]),
                onChange: up => changes.push(`${name}:${up}`),
                timeoutMs: 10_000,
                intervalMs: 10_000,
            })
        const signals: AbortSignal[] = []
        const old = make("old", signal => {
            signals.push(signal)
            return new Promise((_, reject) => {
                pending.fail = reject
            })
        })
        const fresh = make("new", () => Promise.resolve())

        old.start()
        await sleep(0)
        expect(pending.fail).toBeDefined()
        old.stop()

        fresh.start()
        await sleep(0)
        pending.fail?.(new Error("Connection terminated"))
        await sleep(0)
        fresh.stop()

        // Before the fix: [["new",1],["old",0]].
        expect(gauge).toEqual([["new", 1]])
        expect(changes).toEqual([])
        // stop() aborted the query still in flight.
        expect(signals[0]?.aborted).toBe(true)

        // A stopped probe cannot be started again.
        old.start()
        await sleep(0)
        expect(signals).toHaveLength(1)
    })
})
