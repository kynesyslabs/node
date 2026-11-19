import { describe, expect, it } from "bun:test"
import { existsSync, readFileSync } from "fs"
import { resolve } from "path"
import {
    agreedHeight,
    committeeFloor,
    drillPreconditionError,
    emptyMarks,
    evaluateHalt,
    evaluateNoCrash,
    evaluateRecovery,
    evaluateSettle,
    formatSeconds,
    phaseDurations,
    signatureQuorum,
} from "./lib/haltDrill"

const REHEARSAL_DIR = resolve(import.meta.dir)
const SCENARIO = "scenarios/12-quorum-loss-halt-recovery.ts"

describe("G3-6: quorum-loss drill is shipped and registered", () => {
    // Fails at 6b4867dc: no scenario stops 2 of 4 validators.
    it("scenario file exists", () => {
        expect(existsSync(resolve(REHEARSAL_DIR, SCENARIO))).toBe(true)
    })
    it("run-all.sh runs it", () => {
        const runAll = readFileSync(resolve(REHEARSAL_DIR, "run-all.sh"), "utf8")
        expect(runAll).toContain(SCENARIO)
    })
    it("scenario stops exactly two validators and starts them again", () => {
        const src = readFileSync(resolve(REHEARSAL_DIR, SCENARIO), "utf8")
        expect(src).toMatch(/STOPPED\s*=\s*\[\s*3\s*,\s*4\s*\]/)
        expect(src).toContain("stopService(")
        expect(src).toContain("startService(")
    })
    it("drill genesis takes the launch fork set from the mainnet genesis template", () => {
        const src = readFileSync(resolve(REHEARSAL_DIR, SCENARIO), "utf8")
        expect(src).toContain("withLaunchForks(genesis)")
        expect(src).not.toContain("LAUNCH_FORKS")
    })
})

describe("quorum arithmetic mirrors the node", () => {
    it("4 validators, shardSize 4: quorum 3, so 2 survivors halt", () => {
        expect(signatureQuorum(4, 4)).toBe(3)
        expect(committeeFloor(4)).toBe(3)
        expect(drillPreconditionError(4, 4, 2)).toBeNull()
    })
    it("shardSize 10 with a 4-validator pool cannot forge at all", () => {
        expect(committeeFloor(10)).toBe(7)
        expect(drillPreconditionError(10, 4, 2)).toContain("cannot forge")
    })
    it("3 survivors of 4 would not halt", () => {
        expect(drillPreconditionError(4, 4, 3)).toContain("would not halt")
    })
})

describe("halt verdict", () => {
    const s = (atMs: number, h1: number, h2: number) => ({
        atMs,
        heights: { 1: h1, 2: h2 },
    })
    it("passes when survivors stay at the halt height and answer", () => {
        const v = evaluateHalt([1, 2], 12, [s(0, 12, 12), s(10_000, 12, 12)], 2)
        expect(v.pass).toBe(true)
    })
    it("fails when a survivor forges past the halt height", () => {
        const v = evaluateHalt([1, 2], 12, [s(0, 12, 12), s(10_000, 13, 12)], 2)
        expect(v.pass).toBe(false)
        expect(v.reasons[0]).toContain("without quorum")
    })
    it("fails when a survivor stops answering", () => {
        const v = evaluateHalt([1, 2], 12, [s(0, 12, -1), s(10_000, 12, 12)], 2)
        expect(v.pass).toBe(false)
    })
    it("fails with too few samples", () => {
        expect(evaluateHalt([1, 2], 12, [s(0, 12, 12)], 2).pass).toBe(false)
    })
    it("fails when a survivor's head moves back below the halt height", () => {
        const v = evaluateHalt([1, 2], 12, [s(0, 12, 12), s(10_000, 11, 12)], 2)
        expect(v.pass).toBe(false)
        expect(v.reasons[0]).toContain("went back")
    })
})

describe("survivor agreement", () => {
    it("returns the shared head only when every node answers the same", () => {
        expect(agreedHeight([1, 2], { 1: 12, 2: 12 })).toBe(12)
        expect(agreedHeight([1, 2], { 1: 12, 2: 11 })).toBeNull()
        expect(agreedHeight([1, 2], { 1: 12, 2: -1 })).toBeNull()
        expect(agreedHeight([1, 2], { 1: 12 })).toBeNull()
    })
})

describe("settle verdict", () => {
    const row = (node: number, n: number, sigs: number, hash = `h${n}`) => ({
        node,
        number: n,
        hash,
        signatures: sigs,
    })
    it("passes when nothing landed after the stop", () => {
        expect(evaluateSettle([1, 2], 12, 12, [], 3).pass).toBe(true)
    })
    it("passes when an in-flight block landed with quorum", () => {
        const rows = [row(1, 13, 4), row(2, 13, 3)]
        expect(evaluateSettle([1, 2], 12, 13, rows, 3).pass).toBe(true)
    })
    it("fails when the survivors committed a 2-signature block during settle", () => {
        // The gap the review found: before this check, haltHeight was taken
        // after settle and only blocks above it were signature-checked.
        const rows = [row(1, 13, 2), row(2, 13, 2)]
        const v = evaluateSettle([1, 2], 12, 13, rows, 3)
        expect(v.pass).toBe(false)
        expect(v.reasons.join(" ")).toContain("without quorum")
    })
    it("fails when a settle block is missing on a survivor", () => {
        expect(evaluateSettle([1, 2], 12, 13, [row(1, 13, 3)], 3).pass).toBe(false)
    })
    it("fails when the survivors store different settle blocks", () => {
        const rows = [row(1, 13, 3, "a"), row(2, 13, 3, "b")]
        expect(evaluateSettle([1, 2], 12, 13, rows, 3).pass).toBe(false)
    })
    it("fails when the halt height is below the pre-stop height", () => {
        expect(evaluateSettle([1, 2], 12, 11, [], 3).pass).toBe(false)
    })
})

describe("recovery verdict", () => {
    const nodes = [1, 2, 3, 4]
    const rows = (n: number, sigs: number, hashFor = (_: number) => `h${n}`) =>
        nodes.map(node => ({ node, number: n, hash: hashFor(node), signatures: sigs }))
    const heads = { 1: 15, 2: 15, 3: 15, 4: 15 }
    it("passes when all nodes converge with quorum-signed blocks", () => {
        const all = [12, 13, 14, 15].flatMap(n => rows(n, 3))
        expect(evaluateRecovery(nodes, 12, 15, heads, all, 3).pass).toBe(true)
    })
    it("fails on a hash divergence", () => {
        const all = [12, 13, 14, 15].flatMap(n =>
            rows(n, 3, node => (n === 14 && node === 4 ? "fork" : `h${n}`)),
        )
        expect(evaluateRecovery(nodes, 12, 15, heads, all, 3).pass).toBe(false)
    })
    it("fails when a post-halt block lacks quorum signatures", () => {
        const all = [12, 13, 14, 15].flatMap(n => rows(n, n === 13 ? 2 : 3))
        expect(evaluateRecovery(nodes, 12, 15, heads, all, 3).pass).toBe(false)
    })
    it("checks signatures from the pre-stop height, covering settle blocks", () => {
        // pre-stop 11, a 2-signature block 12 committed during settle.
        const all = [11, 12, 13, 14, 15].flatMap(n => rows(n, n === 12 ? 2 : 3))
        expect(evaluateRecovery(nodes, 11, 15, heads, all, 3).pass).toBe(false)
    })
    it("fails when a restarted node never catches up", () => {
        const all = [12, 13, 14, 15].flatMap(n => rows(n, 3))
        expect(
            evaluateRecovery(nodes, 12, 15, { ...heads, 4: 12 }, all, 3).pass,
        ).toBe(false)
    })
})

describe("no-crash verdict", () => {
    it("fails when a survivor's restart count moved", () => {
        expect(evaluateNoCrash({ 1: 0, 2: 0 }, { 1: 0, 2: 1 }, [1, 2]).pass).toBe(false)
        expect(evaluateNoCrash({ 1: 0, 2: 0 }, { 1: 0, 2: 0 }, [1, 2]).pass).toBe(true)
    })
})

describe("phase durations", () => {
    const full = {
        t_up: 1_000,
        t_baseline: 61_000,
        t_stop: 65_000,
        t_halt_confirmed: 90_000,
        t_hold_end: 210_000,
        t_restart: 212_000,
        t_first_new_block: 242_000,
        t_converged: 300_000,
    }

    it("computes every phase from a full set of marks", () => {
        expect(phaseDurations(full)).toEqual({
            coldStartToBaselineMs: 60_000,
            stopToHaltConfirmedMs: 25_000,
            haltHoldMs: 120_000,
            restartToFirstNewBlockMs: 30_000,
            restartToConvergedMs: 88_000,
            totalMs: 299_000,
        })
    })
    it("gives null for the phases that use a missing mark", () => {
        const d = phaseDurations({ ...full, t_first_new_block: null, t_up: null })
        expect(d.restartToFirstNewBlockMs).toBeNull()
        expect(d.coldStartToBaselineMs).toBeNull()
        expect(d.totalMs).toBeNull()
        expect(d.stopToHaltConfirmedMs).toBe(25_000)
        expect(d.haltHoldMs).toBe(120_000)
        expect(d.restartToConvergedMs).toBe(88_000)
    })
    it("gives all null when no mark was taken", () => {
        expect(Object.values(phaseDurations(emptyMarks())).every(v => v === null)).toBe(true)
    })
    it("reports marks out of order as they are", () => {
        const d = phaseDurations({ ...full, t_hold_end: 80_000, t_first_new_block: 200_000 })
        expect(d.haltHoldMs).toBe(-10_000)
        expect(d.restartToFirstNewBlockMs).toBe(-12_000)
        // untouched phases are unchanged
        expect(d.restartToConvergedMs).toBe(88_000)
    })
    it("formats seconds with one decimal and n/a for a missing value", () => {
        expect(formatSeconds(60_040)).toBe("60.0s")
        expect(formatSeconds(88_460)).toBe("88.5s")
        expect(formatSeconds(-10_000)).toBe("-10.0s")
        expect(formatSeconds(null)).toBe("n/a")
    })
})
