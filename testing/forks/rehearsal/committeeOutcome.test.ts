import { describe, expect, it } from "bun:test"
import { readFileSync } from "fs"
import { resolve } from "path"
import { main, sequentialStopOutcome } from "./lib/committeeOutcome"

const RUN_SH = resolve(import.meta.dir, "../../devnet/quorum-drills/run.sh")

const outcomes = (n: number, s: number, stops: number) =>
    Array.from({ length: stops }, (_, i) => sequentialStopOutcome(n, s, i + 1).outcome)

describe("sequentialStopOutcome", () => {
    it("gives the old bash rule (progress iff N-k >= q) for every N <= shardSize", () => {
        for (let s = 1; s <= 13; s++) {
            const q = Math.floor((2 * s) / 3) + 1
            for (let n = 1; n <= s; n++) {
                for (let k = 1; k <= n; k++) {
                    expect(sequentialStopOutcome(n, s, k).outcome).toBe(n - k >= q ? "progress" : "stall")
                }
            }
        }
    })
    it("matches the README table of the existing drop scenarios", () => {
        expect(outcomes(7, 7, 3)).toEqual(["progress", "progress", "stall"])
        expect(outcomes(7, 10, 1)).toEqual(["stall"])
        expect(outcomes(10, 10, 4)).toEqual(["progress", "progress", "progress", "stall"])
    })
    it("drop-n30s10: every one of the 4 stops keeps the chain forging", () => {
        expect(outcomes(30, 10, 4)).toEqual(["progress", "progress", "progress", "progress"])
        const first = sequentialStopOutcome(30, 10, 1)
        expect(first).toEqual({ outcome: "progress", pool: 30, committee: 10, worstLive: 9, bestLive: 10, need: 7 })
    })
    it("at 30 of shardSize 10 the chain forges one at a time down to 7 live, and stalls below", () => {
        const all = outcomes(30, 10, 30)
        // 23 stops leave 7 live; the 24th leaves 6
        expect(all.slice(0, 23).every(o => o === "progress")).toBe(true)
        expect(all[23]).toBe("stall")
    })
    it("names a draw-dependent stop when the victim's draw decides", () => {
        // shardSize 13, pool 11: the whole pool is the committee, 10 live >= floor 9
        expect(sequentialStopOutcome(12, 13, 2).outcome).toBe("progress")
        // shardSize 3, floor 3: pool 5 -> committee 3, worst 2 < 3, best 3 >= 3, after 4 -> 3 live
        expect(sequentialStopOutcome(5, 3, 1)).toMatchObject({ outcome: "draw", worstLive: 2, bestLive: 3, need: 3 })
    })
    it("refuses impossible arguments", () => {
        expect(() => sequentialStopOutcome(4, 10, 5)).toThrow(RangeError)
        expect(() => sequentialStopOutcome(4, 0, 1)).toThrow(RangeError)
        expect(() => sequentialStopOutcome(4, 10, 0)).toThrow(RangeError)
    })
})

describe("CLI", () => {
    it("exit 0 with the outcome first, exit 2 on bad arguments", () => {
        expect(main(["30", "10", "4"])).toBe(0)
        expect(main(["30", "10"])).toBe(2)
        expect(main(["30", "10", "x"])).toBe(2)
        expect(main(["3", "10", "4"])).toBe(2)
    })
})

describe("run.sh wiring", () => {
    const sh = readFileSync(RUN_SH, "utf8")
    it("decides each drop step with this script, not with a rule of its own", () => {
        expect(sh).toContain("testing/forks/rehearsal/lib/committeeOutcome.ts")
        expect(sh).not.toMatch(/if \[ "\$\{live\}" -ge "\$\{Q\}" \]; then expect=progress/)
    })
    it("defines drop-n30s10 with 4 stops", () => {
        expect(sh).toMatch(/^\s+drop-n30s10\) N=30; SHARD=10; START=30; STOPS=4 ;;$/m)
    })
})
