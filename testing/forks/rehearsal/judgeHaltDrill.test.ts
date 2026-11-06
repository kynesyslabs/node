import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"
import { committeeFloor, drillPreconditionError, signatureQuorum } from "./lib/haltDrill"
import {
    DrillInputError,
    type DrillInput,
    formatReport,
    guaranteedTolerance,
    judgeDrill,
    main,
    parseDrillInput,
    ridePreconditionError,
    timingsLine,
} from "./lib/judgeHaltDrill"

const REHEARSAL_DIR = resolve(import.meta.dir)
const FIXTURES = resolve(REHEARSAL_DIR, "fixtures/halt-judge")
const RUN_SH = resolve(REHEARSAL_DIR, "../../devnet/quorum-drills/run.sh")

function loadRaw(name: string): any {
    return JSON.parse(readFileSync(resolve(FIXTURES, `${name}.json`), "utf8"))
}

function load(name: string): DrillInput {
    return parseDrillInput(loadRaw(name))
}

function failedPhases(input: DrillInput): string[] {
    return judgeDrill(input)
        .phases.filter(p => !p.pass)
        .map(p => p.id)
}

function reasonsOf(input: DrillInput, id: string): string[] {
    return judgeDrill(input).phases.find(p => p.id === id)?.reasons ?? []
}

describe("input parsing", () => {
    it("reads every pass fixture", () => {
        for (const name of ["halt-n10s10.pass", "halt-n13s10.pass", "ride-n13s10.pass"]) {
            expect(() => load(name)).not.toThrow()
        }
    })
    it("turns JSON object keys into numeric node ids", () => {
        const input = load("halt-n10s10.pass")
        expect(input.baseline.heads[10]).toBe(6)
        expect(input.restartCounts.before[1]).toBe(0)
        expect(input.settle?.rows[0]).toEqual({
            node: 1,
            number: 8,
            hash: expect.any(String),
            signatures: 10,
        })
    })
    it("keeps marks as epoch milliseconds and null for marks not reached", () => {
        const input = load("ride-n13s10.pass")
        expect(input.marks.t_stop).toBe(Date.parse("2026-11-04T12:02:05.000Z"))
        expect(input.marks.t_restart).toBeNull()
    })
    it("accepts null for phases the run did not reach", () => {
        const raw = loadRaw("halt-n10s10.pass")
        raw.settle = null
        raw.hold = null
        raw.recovery = null
        const input = parseDrillInput(raw)
        expect(input.settle).toBeNull()
        expect(input.recovery).toBeNull()
    })
    it("rejects input that is not an object", () => {
        expect(() => parseDrillInput([])).toThrow(DrillInputError)
        expect(() => parseDrillInput(null)).toThrow("not a JSON object")
    })
    it("lists every problem, with the path of each", () => {
        const raw = loadRaw("halt-n10s10.pass")
        raw.mode = "sideways"
        raw.stopped = [7, 7, 11]
        raw.baseline.heads = { x: 6 }
        raw.settle.rows[0].hash = ""
        raw.marks.t_stop = "yesterday"
        let error: DrillInputError | undefined
        try {
            parseDrillInput(raw)
        } catch (e) {
            error = e as DrillInputError
        }
        expect(error).toBeInstanceOf(DrillInputError)
        const text = (error?.problems ?? []).join("\n")
        expect(text).toContain("mode:")
        expect(text).toContain("stopped: duplicate node ids")
        expect(text).toContain("stopped: node-11 is not among the 10 validators")
        expect(text).toContain("baseline.heads: key \"x\" is not a node id")
        expect(text).toContain("settle.rows[0].hash")
        expect(text).toContain("marks.t_stop")
    })
    it("rejects a drill that stops nobody", () => {
        const raw = loadRaw("halt-n10s10.pass")
        raw.stopped = []
        expect(() => parseDrillInput(raw)).toThrow("no validator is stopped")
    })
    it("rejects a missing field instead of treating it as zero", () => {
        const raw = loadRaw("halt-n10s10.pass")
        delete raw.preStopHeight
        expect(() => parseDrillInput(raw)).toThrow("preStopHeight")
    })
})

describe("quorum arithmetic at mainnet shape", () => {
    it("shardSize 10 needs 7 signatures with 10 or 13 validators", () => {
        expect(signatureQuorum(10, 10)).toBe(7)
        expect(signatureQuorum(10, 13)).toBe(7)
        expect(committeeFloor(10)).toBe(7)
    })
    it("both halt cases leave 6 survivors, below the quorum", () => {
        expect(drillPreconditionError(10, 10, 6)).toBeNull()
        expect(drillPreconditionError(10, 13, 6)).toBeNull()
        // 7 live validators still forge: not a halt drill
        expect(drillPreconditionError(10, 13, 7)).toContain("would not halt")
    })
    it("the guaranteed tolerance is committee size minus quorum: 3 at 10 and at 13 validators", () => {
        expect(guaranteedTolerance(10, 10)).toBe(3)
        expect(guaranteedTolerance(10, 13)).toBe(3)
        expect(guaranteedTolerance(4, 4)).toBe(1)
    })
})

describe("halt drill verdict", () => {
    it("passes the 10-validator fixture: 4 stopped, 6 survivors", () => {
        const verdict = judgeDrill(load("halt-n10s10.pass"))
        expect(verdict.pass).toBe(true)
        expect(verdict.survivors).toEqual([1, 2, 3, 4, 5, 6])
        expect(verdict.quorum).toBe(7)
        expect(verdict.phases.map(p => p.id)).toEqual(["P1", "P2", "P3", "P4", "P5", "P6"])
        expect(verdict.haltHeight).toBe(9)
        expect(verdict.targetHeight).toBe(12)
        expect(verdict.settleBlocks).toBe(1)
    })
    it("passes the 13-validator fixture: 7 stopped, 6 survivors", () => {
        const verdict = judgeDrill(load("halt-n13s10.pass"))
        expect(verdict.pass).toBe(true)
        expect(verdict.survivors).toEqual([1, 2, 3, 4, 5, 6])
        expect(verdict.quorum).toBe(7)
    })
    it("reports the phase durations of scenario 12", () => {
        const d = judgeDrill(load("halt-n13s10.pass")).durationsMs
        expect(d).toEqual({
            coldStartToBaselineMs: 95_000,
            stopToHaltConfirmedMs: 25_000,
            haltHoldMs: 122_000,
            restartToFirstNewBlockMs: 26_000,
            restartToConvergedMs: 55_000,
            totalMs: 330_000,
        })
    })
    it("fails a settle block with fewer than q signatures (the survivors committed alone)", () => {
        const input = load("halt-n10s10.settle-subquorum")
        expect(failedPhases(input)).toContain("P2")
        expect(reasonsOf(input, "P2")[0]).toContain("settle block 9 on node-1: 6 signatures < quorum 7")
        expect(judgeDrill(input).pass).toBe(false)
    })
    it("the sub-quorum block also fails the recovery check, which starts at the pre-stop height", () => {
        expect(reasonsOf(load("halt-n10s10.settle-subquorum"), "P5").join("\n")).toContain(
            "height 9 on node-10: 6 signatures < quorum 7",
        )
    })
    it("fails when a survivor advances past the halt height during the hold", () => {
        const input = load("halt-n13s10.hold-advance")
        expect(failedPhases(input)).toEqual(["P3"])
        expect(reasonsOf(input, "P3")[0]).toContain("node-3 advanced to 10 > halt height 9")
    })
    it("fails when a survivor does not answer during the hold", () => {
        const raw = loadRaw("halt-n10s10.pass")
        raw.hold.samples[2].heights["4"] = -1
        const input = parseDrillInput(raw)
        expect(failedPhases(input)).toEqual(["P3"])
        expect(reasonsOf(input, "P3")[0]).toContain("node-4 did not answer")
    })
    it("fails when fewer hold samples than the window were taken", () => {
        const raw = loadRaw("halt-n10s10.pass")
        raw.hold.samples = raw.hold.samples.slice(0, 5)
        expect(reasonsOf(parseDrillInput(raw), "P3")[0]).toContain("only 5 samples, need 12")
    })
    it("fails when the survivors do not agree after the settle period", () => {
        const raw = loadRaw("halt-n10s10.pass")
        raw.settle.heads["2"] = 8
        const input = parseDrillInput(raw)
        expect(reasonsOf(input, "P2")[0]).toContain("did not agree on a head")
        expect(judgeDrill(input).haltHeight).toBeNull()
        expect(failedPhases(input)).toEqual(["P2", "P3", "P4", "P5"])
    })
    it("fails halt agreement when the survivors hold different hashes at the halt height", () => {
        const raw = loadRaw("halt-n13s10.pass")
        raw.settle.rows.find((r: any) => r.node === 6 && r.number === 9).hash = "0xfork"
        const input = parseDrillInput(raw)
        expect(failedPhases(input)).toContain("P4")
        expect(reasonsOf(input, "P4")[0]).toContain("height 9: hash divergence")
    })
    it("fails recovery when two hashes sit at one height", () => {
        const input = load("halt-n13s10.recovery-fork")
        expect(failedPhases(input)).toEqual(["P5"])
        expect(reasonsOf(input, "P5")[0]).toContain("height 11: hash divergence")
    })
    it("fails recovery when a restarted validator never reaches the target", () => {
        const raw = loadRaw("halt-n13s10.pass")
        raw.recovery.heads["13"] = 10
        raw.recovery.rows = raw.recovery.rows.filter((r: any) => !(r.node === 13 && r.number > 10))
        const reasons = reasonsOf(parseDrillInput(raw), "P5").join("\n")
        expect(reasons).toContain("node-13 head 10 < target 12")
        expect(reasons).toContain("height 12: stored on 12/13 nodes")
    })
    it("fails recovery reached only after the timeout", () => {
        const raw = loadRaw("halt-n13s10.pass")
        raw.marks.t_converged = null
        const input = parseDrillInput(raw)
        expect(failedPhases(input)).toEqual(["P5"])
        expect(reasonsOf(input, "P5")).toEqual([expect.stringContaining("inside the timeout")])
    })
    it("fails when a survivor was restarted by docker", () => {
        const input = load("halt-n10s10.survivor-crash")
        expect(failedPhases(input)).toEqual(["P6"])
        expect(reasonsOf(input, "P6")[0]).toContain("node-2 restart count 0 -> 1")
    })
    it("does not count a restarted victim as a crash", () => {
        const raw = loadRaw("halt-n10s10.pass")
        raw.restartCounts.before["9"] = 0
        raw.restartCounts.after["9"] = 3
        expect(judgeDrill(parseDrillInput(raw)).pass).toBe(true)
    })
    it("fails the baseline below the required height or with divergent hashes", () => {
        const low = loadRaw("halt-n10s10.pass")
        low.baselineMinHeight = 7
        expect(reasonsOf(parseDrillInput(low), "P1")[0]).toContain("baseline height 6 < required 7")
        const fork = loadRaw("halt-n10s10.pass")
        fork.baseline.rows[3].hash = "0xother"
        expect(reasonsOf(parseDrillInput(fork), "P1")[0]).toContain("hash divergence")
    })
    it("marks every phase after an early end as not reached", () => {
        const raw = loadRaw("halt-n10s10.pass")
        raw.settle = null
        raw.hold = null
        raw.recovery = null
        const verdict = judgeDrill(parseDrillInput(raw))
        expect(verdict.pass).toBe(false)
        expect(verdict.phases.find(p => p.id === "P2")?.reasons[0]).toContain("not reached")
        expect(verdict.phases.find(p => p.id === "P5")?.reasons[0]).toContain("no halt height")
    })
    it("refuses a drill whose survivors still hold a quorum", () => {
        const raw = loadRaw("halt-n10s10.pass")
        raw.stopped = [8, 9, 10]
        const verdict = judgeDrill(parseDrillInput(raw))
        expect(verdict.phases.map(p => p.id)).toEqual(["P0"])
        expect(verdict.phases[0].reasons[0]).toContain("would not halt")
    })
})

// run.sh's lockstep wait accepts heads one apart and returns the lower one, so
// the pre-stop height can be one below the head of some nodes at the stop.
// Everything after it is a settle block, whatever the nodes held at the stop.
describe("pre-stop height one below some nodes' head", () => {
    const N = 13
    const SURVIVORS = [1, 2, 3, 4, 5, 6]
    const STRADDLE_BLOCK = 9

    /**
     * halt-n13s10.pass with pre = 8: nodes 1..3 (half the survivors) and 7..9
     * already hold block 9 when the stop lands, the others get it from the
     * settle. Every node's baseline head is split the same way. Block 9
     * carries `signatures` on every node that stores it.
     */
    function straddled(signatures: number): any {
        const raw = loadRaw("halt-n13s10.pass")
        expect(raw.preStopHeight).toBe(STRADDLE_BLOCK - 1)
        for (const id of [7, 8, 9, 10, 11, 12, 13]) raw.baseline.heads[id] = raw.baseline.height + 1
        for (const rows of [raw.settle.rows, raw.recovery.rows]) {
            for (const r of rows) if (r.number === STRADDLE_BLOCK) r.signatures = signatures
        }
        return raw
    }

    it("passes when the block above pre has a quorum of signatures on every survivor", () => {
        const verdict = judgeDrill(parseDrillInput(straddled(signatureQuorum(10, N))))
        expect(verdict.phases.filter(p => !p.pass)).toEqual([])
        expect(verdict.pass).toBe(true)
        expect(verdict.preStopHeight).toBe(8)
        expect(verdict.haltHeight).toBe(STRADDLE_BLOCK)
        expect(verdict.settleBlocks).toBe(1)
    })
    it("fails when that block is below quorum, in the settle and recovery checks", () => {
        const input = parseDrillInput(straddled(signatureQuorum(10, N) - 1))
        expect(failedPhases(input)).toEqual(["P2", "P5"])
        for (const id of SURVIVORS) {
            expect(reasonsOf(input, "P2").join("\n")).toContain(
                `settle block ${STRADDLE_BLOCK} on node-${id}: 6 signatures < quorum 7`,
            )
        }
        expect(judgeDrill(input).pass).toBe(false)
    })
    it("a lower pre-stop height only widens the check: the same sub-quorum block passes unseen when pre is 9", () => {
        const raw = straddled(signatureQuorum(10, N) - 1)
        raw.preStopHeight = STRADDLE_BLOCK
        const lax = parseDrillInput(raw)
        expect(reasonsOf(lax, "P2")).toEqual([])
        expect(reasonsOf(lax, "P5")).toEqual([])
        raw.preStopHeight = STRADDLE_BLOCK - 1
        expect(reasonsOf(parseDrillInput(raw), "P2")).not.toEqual([])
    })
    it("fails when only some survivors store the block above pre", () => {
        const raw = straddled(signatureQuorum(10, N))
        raw.settle.rows = raw.settle.rows.filter((r: any) => !(r.number === STRADDLE_BLOCK && [4, 5, 6].includes(r.node)))
        expect(reasonsOf(parseDrillInput(raw), "P2").join("\n")).toContain(
            `settle block ${STRADDLE_BLOCK}: stored on 3/6 survivors`,
        )
    })
    it("fails when the nodes hold two hashes at the block above pre", () => {
        const raw = straddled(signatureQuorum(10, N))
        for (const r of raw.settle.rows) if (r.number === STRADDLE_BLOCK && r.node === 2) r.hash = "0xother"
        expect(reasonsOf(parseDrillInput(raw), "P2").join("\n")).toContain(`settle block ${STRADDLE_BLOCK}: hash divergence`)
    })
    it("accepts a baseline whose heads are one above its height, and still checks the hash at that height", () => {
        const input = parseDrillInput(straddled(signatureQuorum(10, N)))
        expect(reasonsOf(input, "P1")).toEqual([])
        const raw = straddled(signatureQuorum(10, N))
        raw.baseline.rows[3].hash = "0xother"
        expect(reasonsOf(parseDrillInput(raw), "P1")[0]).toContain("hash divergence")
    })
})

describe("ride drill verdict", () => {
    it("passes when the 10 survivors keep forging with >= 7 signatures", () => {
        const verdict = judgeDrill(load("ride-n13s10.pass"))
        expect(verdict.pass).toBe(true)
        expect(verdict.survivors).toHaveLength(10)
        expect(verdict.phases.map(p => p.id)).toEqual(["P1", "R2", "P6"])
        expect(verdict.targetHeight).toBe(11)
        expect(verdict.rideMs).toEqual({ stopToFirstNewBlockMs: 15_000, stopToTargetMs: 50_000 })
    })
    it("fails when the survivors never advance", () => {
        const input = load("ride-n13s10.stalled")
        expect(failedPhases(input)).toEqual(["R2"])
        expect(reasonsOf(input, "R2")[0]).toContain("node-1 head 8 < target 11")
    })
    it("fails a ride that reached the target only after the timeout", () => {
        const raw = loadRaw("ride-n13s10.pass")
        raw.marks.t_converged = null
        const input = parseDrillInput(raw)
        expect(failedPhases(input)).toEqual(["R2"])
        expect(reasonsOf(input, "R2")).toEqual([expect.stringContaining("inside the timeout")])
    })
    it("fails a block with fewer than 7 signatures", () => {
        const raw = loadRaw("ride-n13s10.pass")
        for (const r of raw.ride.rows) if (r.number === 10) r.signatures = 6
        const input = parseDrillInput(raw)
        expect(failedPhases(input)).toEqual(["R2"])
        expect(reasonsOf(input, "R2")[0]).toContain("height 10 on node-1: 6 signatures < quorum 7")
    })
    it("fails when survivors hold two hashes at one height", () => {
        const raw = loadRaw("ride-n13s10.pass")
        raw.ride.rows.find((r: any) => r.node === 10 && r.number === 10).hash = "0xfork"
        expect(reasonsOf(parseDrillInput(raw), "R2")[0]).toContain("height 10: hash divergence")
    })
    it("refuses to judge a stop count beyond the guaranteed tolerance", () => {
        const raw = loadRaw("ride-n13s10.pass")
        raw.stopped = [10, 11, 12, 13]
        const verdict = judgeDrill(parseDrillInput(raw))
        expect(verdict.phases.map(p => p.id)).toEqual(["P0"])
        expect(verdict.phases[0].reasons[0]).toContain("exceeds the 3 the committee code guarantees")
    })
    it("refuses when the pre-stop pool is smaller than the committee", () => {
        const raw = loadRaw("ride-n13s10.pass")
        raw.preStopPeerlist = 9
        expect(judgeDrill(parseDrillInput(raw)).phases[0].reasons[0]).toContain(
            "lists 9 validators, fewer than the committee of 10",
        )
        expect(ridePreconditionError(10, 13, 3, 13)).toBeNull()
        expect(ridePreconditionError(10, 13, 3, 10)).toBeNull()
        expect(ridePreconditionError(10, 13, 4, 13)).not.toBeNull()
    })
})

describe("report and CLI", () => {
    it("prints scenario 12's DRILL_TIMINGS line with the validator counts", () => {
        const input = load("halt-n13s10.pass")
        const lines = formatReport(input, judgeDrill(input))
        const line = lines.find(l => l.startsWith("DRILL_TIMINGS "))
        expect(line).toBeDefined()
        const payload = JSON.parse((line ?? "").slice("DRILL_TIMINGS ".length))
        expect(payload.scenario).toBe("halt-n13s10")
        expect(payload.durationsMs.restartToConvergedMs).toBe(55_000)
        expect(payload.validators).toBe(13)
        expect(payload.stopped).toEqual([7, 8, 9, 10, 11, 12, 13])
        expect(payload.marks.t_stop).toBe("2026-11-04T12:02:05.000Z")
        expect(lines).toContain("timing: restart to all 13 converged 55.0s")
        // an input from before the exclusions has none, and says nothing about them
        expect(input.excludedForks).toEqual({})
        expect("excludedForks" in payload).toBe(false)
        expect(lines.find(l => l.startsWith("config: "))).not.toContain("excluded")
    })
    it("carries the excluded forks into DRILL_TIMINGS, the verdict timings and the config line", () => {
        const raw = loadRaw("halt-n10s10.pass")
        const why = "needs a genesis snapshot; the drills use the legacy genesis path"
        raw.excludedForks = { identityCarryover: why }
        raw.forks = { ...raw.forks, identityCarryover: null }
        const input = parseDrillInput(raw)
        expect(input.excludedForks).toEqual({ identityCarryover: why })
        const lines = formatReport(input, judgeDrill(input))
        const line = lines.find(l => l.startsWith("DRILL_TIMINGS ")) ?? ""
        expect(JSON.parse(line.slice("DRILL_TIMINGS ".length)).excludedForks).toEqual({ identityCarryover: why })
        expect(lines.find(l => l.startsWith("config: "))).toContain(`; excluded: identityCarryover (${why})`)
        expect(timingsLine(input, judgeDrill(input)).excludedForks).toEqual({ identityCarryover: why })
        raw.excludedForks = { identityCarryover: "" }
        expect(() => parseDrillInput(raw)).toThrow("excludedForks.identityCarryover")
        raw.excludedForks = ["identityCarryover"]
        expect(() => parseDrillInput(raw)).toThrow("excludedForks: expected an object")
    })
    it("exits 0 on pass, 1 on fail and 2 on malformed input, and writes the verdict file", () => {
        const dir = mkdtempSync(join(tmpdir(), "judge-halt-"))
        const out = join(dir, "verdict.json")
        const quiet = process.stdout.write
        const quietErr = process.stderr.write
        process.stdout.write = (() => true) as typeof process.stdout.write
        process.stderr.write = (() => true) as typeof process.stderr.write
        try {
            expect(main([resolve(FIXTURES, "halt-n10s10.pass.json"), "--out", out])).toBe(0)
            const written = JSON.parse(readFileSync(out, "utf8"))
            expect(written.pass).toBe(true)
            expect(written.timings.scenario).toBe("halt-n10s10")
            expect(main([resolve(FIXTURES, "halt-n10s10.settle-subquorum.json")])).toBe(1)
            const bad = join(dir, "bad.json")
            writeFileSync(bad, "{not json")
            expect(main([bad])).toBe(2)
            writeFileSync(bad, JSON.stringify({ mode: "halt" }))
            expect(main([bad])).toBe(2)
            expect(main([])).toBe(2)
            expect(main([join(dir, "missing.json")])).toBe(2)
        } finally {
            process.stdout.write = quiet
            process.stderr.write = quietErr
            rmSync(dir, { recursive: true, force: true })
        }
    })
})

describe("run.sh wiring", () => {
    const runSh = readFileSync(RUN_SH, "utf8")

    function caseLine(name: string): string {
        const m = runSh.match(new RegExp(`^\\s+${name}\\) (.*)$`, "m"))
        if (!m) throw new Error(`run.sh has no case for ${name}`)
        return m[1]
    }

    it("defines the three mainnet-shape cases", () => {
        expect(caseLine("halt-n10s10")).toContain("N=10; SHARD=10; START=10; STOPS=4")
        expect(caseLine("halt-n13s10")).toContain("N=13; SHARD=10; START=13; STOPS=7")
        expect(caseLine("ride-n13s10")).toContain("N=13; SHARD=10; START=13; STOPS=3")
    })
    it("the halt cases stop enough validators to leave fewer than q, and the ride case no more than the tolerance", () => {
        const q = signatureQuorum(10, 13)
        expect(10 - 4).toBeLessThan(signatureQuorum(10, 10))
        expect(13 - 7).toBeLessThan(q)
        expect(13 - 6).toBeGreaterThanOrEqual(q)
        expect(3).toBeLessThanOrEqual(guaranteedTolerance(10, 13))
        expect(4).toBeGreaterThan(guaranteedTolerance(10, 13))
    })
    it("judges with this script rather than in bash", () => {
        expect(runSh).toContain("testing/forks/rehearsal/lib/judgeHaltDrill.ts")
    })
})
