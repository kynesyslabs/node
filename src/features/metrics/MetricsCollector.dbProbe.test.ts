// MetricsCollector.start() and its DbProbe: a start() whose first collection
// threw leaves `running` false, so the node may call start() again. That retry
// must not leave the first probe's timer ticking next to the new one.
import { describe, expect, it, spyOn } from "bun:test"
import { DbProbe } from "./dbProbe"
import { MetricsCollector } from "./MetricsCollector"

const timerOf = (probe: DbProbe) =>
    (probe as unknown as { timer: unknown }).timer

describe("MetricsCollector.start() with the DbProbe", () => {
    it("a second start() after a first one that threw leaves exactly one probe timer running", async () => {
        // No query: the probe's ticks do nothing, so the DataSource is never loaded.
        const tick = spyOn(DbProbe.prototype, "tick").mockResolvedValue(undefined)
        const started: DbProbe[] = []
        const originalStart = DbProbe.prototype.start
        DbProbe.prototype.start = function (this: DbProbe) {
            started.push(this)
            originalStart.call(this)
        }

        const collector = MetricsCollector.getInstance()
        let collections = 0
        ;(collector as unknown as { collectAll: () => Promise<void> }).collectAll =
            async () => {
                collections++
                if (collections === 1) throw new Error("first collection failed")
            }

        try {
            await expect(collector.start()).rejects.toThrow("first collection failed")
            expect(started).toHaveLength(1)
            expect(timerOf(started[0])).not.toBeNull()

            await collector.start()
            expect(started).toHaveLength(2)
            const running = started.filter(p => timerOf(p) !== null)
            expect(running).toHaveLength(1)
            expect(running[0]).toBe(started[1])

            collector.stop()
            expect(started.filter(p => timerOf(p) !== null)).toHaveLength(0)
        } finally {
            collector.stop()
            DbProbe.prototype.start = originalStart
            tick.mockRestore()
        }
    })
})
