import { describe, expect, it } from "bun:test"
import {
    INBOUND_SILENCE_MS,
    judgeSidecarHealth,
    RELAUNCH_BACKOFF_BASE_MS,
    RELAUNCH_BACKOFF_CAP_MS,
    relaunchDelayMs,
    RestartBudget,
    STATS_STALE_HARD_CAP_MS,
    STATS_STALE_MS,
    TICK_LATE_TOLERANCE_MS,
} from "./sidecarHealth"

const base = {
    now: 100_000,
    tickLateMs: 0,
    lastStatsAt: 100_000,
    lastInboundAt: 100_000,
    heightsSubscribers: 3,
    processExited: false,
}

describe("judgeSidecarHealth", () => {
    it("is ok with fresh stats and fresh inbound", () => {
        expect(judgeSidecarHealth(base)).toEqual({ kind: "ok" })
    })

    it("defers to the exit handler once the process is gone", () => {
        expect(
            judgeSidecarHealth({ ...base, processExited: true, lastStatsAt: 0 }),
        ).toEqual({ kind: "ok" })
    })

    it("faults on stale stats with a clean tick", () => {
        const v = judgeSidecarHealth({
            ...base,
            lastStatsAt: base.now - STATS_STALE_MS - 1,
        })
        expect(v).toEqual({ kind: "fault", reason: "stats_stalled" })
    })

    it("defers stale stats on a late tick, but only up to the hard cap", () => {
        const late = TICK_LATE_TOLERANCE_MS + 1
        expect(
            judgeSidecarHealth({
                ...base,
                tickLateMs: late,
                lastStatsAt: base.now - STATS_STALE_MS - 1,
            }),
        ).toEqual({ kind: "deferred", reason: "late_tick" })
        expect(
            judgeSidecarHealth({
                ...base,
                tickLateMs: late,
                lastStatsAt: base.now - STATS_STALE_HARD_CAP_MS - 1,
            }),
        ).toEqual({ kind: "fault", reason: "stats_stalled_hard" })
    })

    it("reports silence when subscribers exist but nothing arrives", () => {
        expect(
            judgeSidecarHealth({
                ...base,
                lastInboundAt: base.now - INBOUND_SILENCE_MS - 1,
            }),
        ).toEqual({ kind: "silent" })
    })

    it("never reports silence with no subscribers (node alone)", () => {
        expect(
            judgeSidecarHealth({
                ...base,
                heightsSubscribers: 0,
                lastInboundAt: 0,
            }),
        ).toEqual({ kind: "ok" })
    })

    it("does not judge silence on a contaminated tick", () => {
        expect(
            judgeSidecarHealth({
                ...base,
                tickLateMs: TICK_LATE_TOLERANCE_MS + 1,
                lastInboundAt: 0,
            }),
        ).toEqual({ kind: "ok" })
    })
})

describe("RestartBudget", () => {
    it("allows max restarts per window and refuses the next", () => {
        const b = new RestartBudget(3, 1000)
        expect(b.take(0)).toBe(true)
        expect(b.take(10)).toBe(true)
        expect(b.take(20)).toBe(true)
        expect(b.take(30)).toBe(false)
        expect(b.used(30)).toBe(3)
    })

    it("forgets restarts outside the window", () => {
        const b = new RestartBudget(2, 1000)
        b.take(0)
        b.take(1)
        expect(b.take(500)).toBe(false)
        expect(b.take(1002)).toBe(true)
        expect(b.used(1002)).toBe(1)
    })
})

describe("relaunchDelayMs", () => {
    const max = () => 1
    const min = () => 0

    it("relaunches at once on the first try of a recovery", () => {
        expect(relaunchDelayMs(0, max)).toBe(0)
    })

    it("doubles per failed attempt up to the cap", () => {
        const delays = [1, 2, 3, 4, 5, 6, 7, 8, 20, 1000].map(i =>
            relaunchDelayMs(i, max),
        )
        expect(delays.slice(0, 7)).toEqual([
            1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000,
        ])
        for (const d of delays.slice(6)) expect(d).toBe(RELAUNCH_BACKOFF_CAP_MS)
    })

    it("jitters within [half, full] of the step, never below half", () => {
        expect(relaunchDelayMs(1, min)).toBe(RELAUNCH_BACKOFF_BASE_MS / 2)
        expect(relaunchDelayMs(30, min)).toBe(RELAUNCH_BACKOFF_CAP_MS / 2)
        for (let i = 0; i < 200; i++) {
            const d = relaunchDelayMs(3)
            expect(d).toBeGreaterThanOrEqual(2_000)
            expect(d).toBeLessThanOrEqual(4_000)
        }
    })

    it("clamps an out-of-range random source", () => {
        expect(relaunchDelayMs(1, () => 5)).toBe(1_000)
        expect(relaunchDelayMs(1, () => -1)).toBe(500)
    })

    it("honours a custom base and cap", () => {
        expect(relaunchDelayMs(1, max, 40, 160)).toBe(40)
        expect(relaunchDelayMs(3, max, 40, 160)).toBe(160)
        expect(relaunchDelayMs(9, max, 40, 160)).toBe(160)
    })
})
