import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"
import {
    judgeCycle,
    judgeRestart,
    longestGap,
    main,
    parseRestartInput,
    parseVictimLog,
    RestartInputError,
    type RestartCycle,
    type RestartInput,
} from "./lib/judgeRestartDrill"

const RUN_SH = resolve(import.meta.dir, "../../devnet/quorum-drills/run.sh")
const FIXTURES = resolve(import.meta.dir, "fixtures/restart-judge")
const T0 = Date.parse("2026-11-17T10:00:00.000Z")
const LIMITS = { bootS: 180, syncS: 60, roundS: 30, drawS: 300, maxGapS: 110 }

const iso = (ms: number) => new Date(ms).toISOString().replace("Z", "123456Z")
const forging = (ms: number, h: number) => `${iso(ms)} [INFO] We are forging block ${h}`
const precommit = (ms: number) => `${iso(ms)} [INFO] [commitLock] Precommit tally for block 0xabc: precommits=7, quorum=7`
const greenLightTimeout = (ms: number) => `${iso(ms)} [WARN] [SEND OUR VALIDATOR PHASE] Timeout waiting for green light`

/** A victim restarted at T0 + offset, serving 20 s later, synced 5 s after, signing its first committee round. */
function cycle(victim: number, offsetS: number, log?: string[]): RestartCycle {
    const t = T0 + offsetS * 1000
    return {
        victim,
        tRestartMs: t,
        tServingMs: t + 20_000,
        servingHead: 40,
        tSyncedMs: t + 25_000,
        restartCountServing: 0,
        restartCountEnd: 0,
        log: log ?? [
            `${iso(t + 15_000)} [INFO] [SIGNING] Restart signing floor: only rounds after 41 are signed`,
            forging(t + 30_000, 42),
            precommit(t + 34_000),
        ],
    }
}

function passing(): RestartInput {
    const validators = 30
    const startHeight = 10
    const endHeight = 30
    const rows = []
    const heads: Record<number, number> = {}
    const counts: Record<number, number> = {}
    for (let n = 1; n <= validators; n++) {
        heads[n] = endHeight
        counts[n] = 0
        for (let h = startHeight; h <= endHeight; h++) rows.push({ node: n, number: h, hash: `0x${h}`, signatures: 8 })
    }
    const blockTimes = []
    for (let h = startHeight; h <= endHeight; h++) blockTimes.push({ number: h, timestamp: Math.floor(T0 / 1000) + (h - startHeight) * 12 })
    return {
        scenario: "restart-n30s10",
        validators,
        shardSize: 10,
        consensusTimeS: 10,
        limits: LIMITS,
        cycles: [cycle(5, 0), cycle(17, 120), cycle(23, 240), cycle(2, 360), cycle(30, 480)],
        startHeight,
        endHeight,
        tEndMs: T0 + (endHeight - startHeight) * 12_000 + 5_000,
        blockTimes,
        heads,
        rows,
        restartCounts: { before: { ...counts }, after: { ...counts } },
    }
}

describe("parseVictimLog", () => {
    it("opens a round at the first forging line of a height and gives it the next precommit", () => {
        const log = parseVictimLog([
            forging(T0, 42),
            "no timestamp line We are forging block 99",
            forging(T0 + 5_000, 42),
            precommit(T0 + 7_000),
            precommit(T0 + 8_000),
            greenLightTimeout(T0 + 9_000),
            forging(T0 + 20_000, 45),
        ])
        expect(log.rounds).toEqual([
            { height: 42, startMs: T0, precommitMs: T0 + 7_000 },
            { height: 45, startMs: T0 + 20_000, precommitMs: null },
        ])
        expect(log.greenLightTimeouts).toBe(1)
    })
    it("ignores the secretary's debug line that has no height", () => {
        expect(parseVictimLog([`${iso(T0)} We are forging block #10 and we are not the secretary`]).rounds).toEqual([])
    })
})

describe("judgeCycle", () => {
    it("passes a victim that signs its first committee round", () => {
        const r = judgeCycle(cycle(5, 0), LIMITS)
        expect(r).toMatchObject({ pass: true, signedRound: 1, bootS: 20, syncS: 5, roundsDrawn: 1 })
        expect(r.signingFloor).toBe("only rounds after 41 are signed")
    })
    it("passes one whose first round is refused by the signing floor and the second signed", () => {
        const t = T0
        const r = judgeCycle(cycle(5, 0, [forging(t + 22_000, 41), forging(t + 40_000, 44), precommit(t + 45_000)]), LIMITS)
        expect(r).toMatchObject({ pass: true, signedRound: 2 })
    })
    it("fails the U-1 shape: drawn round after round, green-light timeouts, no precommit", () => {
        const t = T0
        const log = [forging(t + 22_000, 41), greenLightTimeout(t + 82_000), forging(t + 83_000, 41), greenLightTimeout(t + 143_000), forging(t + 144_000, 41)]
        const r = judgeCycle(cycle(5, 0, log), LIMITS)
        expect(r.pass).toBe(false)
        expect(r.reasons.join()).toMatch(/did not sign at its first committee heights after the restart \(41\); 2 green-light timeout/)
    })
    it("fails a precommit that comes only at the third height drawn", () => {
        const t = T0
        const log = [forging(t + 22_000, 41), forging(t + 40_000, 44), forging(t + 60_000, 47), precommit(t + 62_000)]
        const r = judgeCycle(cycle(5, 0, log), LIMITS)
        expect(r).toMatchObject({ pass: false, signedRound: 3 })
    })
    it("fails a precommit later than one round time after its round started", () => {
        const r = judgeCycle(cycle(5, 0, [forging(T0 + 30_000, 42), precommit(T0 + 61_000)]), LIMITS)
        expect(r.reasons.join()).toMatch(/signed height 42 31s after the round started \(> 30s\)/)
    })
    it("fails a victim never drawn, never serving, slow to sync, or restarted again", () => {
        expect(judgeCycle(cycle(5, 0, []), LIMITS).reasons.join()).toMatch(/not drawn for any committee/)
        expect(judgeCycle({ ...cycle(5, 0), tServingMs: null, tSyncedMs: null }, LIMITS).reasons.join()).toMatch(/never served/)
        expect(judgeCycle({ ...cycle(5, 0), tSyncedMs: T0 + 90_000 }, LIMITS).reasons.join()).toMatch(/reached head 40 70s after serving/)
        expect(judgeCycle({ ...cycle(5, 0), restartCountEnd: 1 }, LIMITS).reasons.join()).toMatch(/restarted again on its own \(count 0 -> 1\)/)
    })
    it("does not count rounds the log shows from before the restart", () => {
        const r = judgeCycle(cycle(5, 0, [forging(T0 - 5_000, 39), precommit(T0 - 3_000), forging(T0 + 30_000, 42), precommit(T0 + 33_000)]), LIMITS)
        expect(r).toMatchObject({ pass: true, signedRound: 1, roundsDrawn: 1 })
    })
    it("keeps the new process' first round at a height the old process had opened", () => {
        // 42 opened before the restart and retried after it: the retry is round 1,
        // so the precommit at 48 is the third round, not the second
        const log = [
            forging(T0 - 5_000, 42),
            forging(T0 + 30_000, 42),
            forging(T0 + 50_000, 45),
            forging(T0 + 70_000, 48),
            precommit(T0 + 72_000),
        ]
        expect(parseVictimLog(log, T0).rounds.map(r => [r.height, r.startMs])).toEqual([
            [42, T0 + 30_000],
            [45, T0 + 50_000],
            [48, T0 + 70_000],
        ])
        const r = judgeCycle(cycle(5, 0, log), LIMITS)
        expect(r).toMatchObject({ pass: false, signedRound: 3, roundsDrawn: 3 })
    })
    it("does not give a pre-restart precommit to a round the new process opened", () => {
        const log = [forging(T0 + 30_000, 42), precommit(T0 - 1_000)]
        expect(judgeCycle(cycle(5, 0, log), LIMITS)).toMatchObject({ pass: false, signedRound: null })
    })
})

describe("longestGap", () => {
    it("takes seconds or milliseconds and counts the open gap to the end", () => {
        expect(longestGap([{ number: 1, timestamp: 1000 }, { number: 2, timestamp: 1030 }], 1_040_000)).toEqual({ gapS: 30, afterHeight: 1, open: false })
        expect(longestGap([{ number: 1, timestamp: T0 }, { number: 2, timestamp: T0 + 10_000 }], T0 + 200_000)).toEqual({ gapS: 190, afterHeight: 2, open: true })
    })
})

describe("judgeRestart", () => {
    it("passes the five-restart drill", () => {
        const v = judgeRestart(passing())
        expect(v.pass).toBe(true)
        expect(v.summary).toMatch(/^PASS restarts=5 n5:ok/)
    })
    it("fails a stall longer than 2 x CONSENSUS_TIME + the timeouts", () => {
        const input = passing()
        input.blockTimes[10].timestamp += 200
        for (let k = 11; k < input.blockTimes.length; k++) input.blockTimes[k].timestamp += 200
        input.tEndMs += 200_000
        const v = judgeRestart(input)
        expect(v.pass).toBe(false)
        expect(v.gap).toMatchObject({ pass: false, gapS: 212, afterHeight: 19 })
    })
    it("fails a fork, a missing signature quorum and a stopped chain", () => {
        const fork = passing()
        fork.rows.find(r => r.node === 3 && r.number === 20)!.hash = "0xother"
        expect(judgeRestart(fork).chain.reasons.join()).toMatch(/height 20: hash divergence/)
        const weak = passing()
        weak.rows.find(r => r.node === 1 && r.number === 21)!.signatures = 6
        expect(judgeRestart(weak).chain.reasons.join()).toMatch(/height 21 on node-1: 6 signatures < quorum 7/)
        const still = passing()
        still.endHeight = still.startHeight
        expect(judgeRestart(still).chain.pass).toBe(false)
    })
    it("fails a validator that was not restarted but crashed; a victim's own count is per cycle", () => {
        const input = passing()
        input.restartCounts.after[4] = 1
        input.restartCounts.after[5] = 3
        const v = judgeRestart(input)
        expect(v.noCrash.reasons).toEqual(["node-4 restart count 0 -> 1: it exited during the drill"])
    })
})

describe("input and CLI", () => {
    it("refuses an input without cycles or limits", () => {
        expect(() => parseRestartInput({ ...passing(), cycles: [] })).toThrow(RestartInputError)
        const { limits: _l, ...noLimits } = passing()
        expect(() => parseRestartInput(noLimits)).toThrow(/limits missing/)
    })
    it("exit 0 on the pass fixture, 1 on the U-1 fixture, 2 on a bad file", () => {
        const dir = mkdtempSync(join(tmpdir(), "restart-judge-"))
        const out = join(dir, "v.json")
        expect(main([join(FIXTURES, "restart-n30s10.pass.json"), "--out", out])).toBe(0)
        expect(JSON.parse(readFileSync(out, "utf8")).pass).toBe(true)
        expect(main([join(FIXTURES, "restart-n30s10.u1-stuck.json")])).toBe(1)
        writeFileSync(join(dir, "bad.json"), "{}")
        expect(main([join(dir, "bad.json")])).toBe(2)
        expect(main([])).toBe(2)
    })
    it("the fixtures are what the generator in this file builds", () => {
        expect(JSON.parse(readFileSync(join(FIXTURES, "restart-n30s10.pass.json"), "utf8"))).toEqual(passing())
    })
})

describe("run.sh wiring", () => {
    const sh = readFileSync(RUN_SH, "utf8")
    it("defines restart-n30s10 and judges it with this script", () => {
        expect(sh).toMatch(/^\s+restart-n30s10\) N=30; SHARD=10; START=30 ;;$/m)
        expect(sh).toContain("testing/forks/rehearsal/lib/judgeRestartDrill.ts")
        expect(sh).toMatch(/^\s+restart-\*\) scenario_restart ;;$/m)
    })
    it("runs the n30 drills on the launch fork set with gossip on", () => {
        expect(sh).toMatch(/case "\$\{SCENARIO\}" in [^)]*\|\*-n30s10\) FORK_SET=launch ;; esac/)
        expect(sh).toMatch(/case "\$\{SCENARIO\}" in [^)]*\|\*-n30s10\) export GOSSIP_ENABLED=true ;; esac/)
    })
    it("reads the victim's log and restart count bounded, and never restarts a victim not drawn", () => {
        const body = (name: string) => {
            const m = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}$`, "m").exec(sh)
            expect(m).not.toBeNull()
            return (m as RegExpExecArray)[0]
        }
        expect(body("round_markers")).toMatch(/bdocker logs --timestamps/)
        expect(body("round_markers")).not.toMatch(/(^|[^b])docker logs --timestamps/)
        expect(body("restart_count_of")).toMatch(/bdocker inspect/)
        const cycleBody = body("restart_cycle")
        expect(cycleBody).toMatch(/\[ "\$\{drawn\}" = 1 \] \|\| restart_error/)
        expect(cycleBody).not.toMatch(/restarting it anyway/)
        // the count is read as soon as the victim serves, before the sync wait
        expect(cycleBody.indexOf("restart_count_of")).toBeGreaterThan(cycleBody.indexOf("t_serving=$(now_ms)"))
        expect(cycleBody.indexOf("restart_count_of")).toBeLessThan(cycleBody.indexOf("REJOIN_SYNC_S"))
    })
})
