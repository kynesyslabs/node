// DbProbe (dbProbe.ts): what demos_db_up reports for a database that answers,
// fails, or never answers, and that a hung probe never stalls the next tick.
import { describe, expect, it } from "bun:test"
import { DbProbe } from "./dbProbe"

const TIMEOUT_MS = 50

function harness(probe: () => Promise<unknown>, intervalMs = 10_000) {
    const reports: Array<[0 | 1, number | null]> = []
    const changes: Array<[0 | 1, string | null]> = []
    let calls = 0
    const db = new DbProbe({
        probe: () => {
            calls++
            return probe()
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
        // Still down: no second log line.
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
            down ? Promise.reject(new Error("Connection terminated")) : Promise.resolve(),
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

    it("start() probes at once and then on every interval; stop() ends it", async () => {
        const h = harness(() => Promise.resolve(), 20)
        h.db.start()
        h.db.start() // a second start does not add a second timer
        await sleep(5)
        expect(h.calls()).toBe(1)
        await sleep(70)
        h.db.stop()
        const afterStop = h.calls()
        // About 4 (one at start, one every 20 ms); timers run late on a loaded host.
        expect(afterStop).toBeGreaterThanOrEqual(2)
        expect(afterStop).toBeLessThanOrEqual(6)
        await sleep(60)
        expect(h.calls()).toBe(afterStop)
        expect(h.reports.every(r => r[0] === 1)).toBe(true)
    })
})
