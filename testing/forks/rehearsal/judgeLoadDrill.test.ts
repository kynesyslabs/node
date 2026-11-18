import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"
import { type LoadInput, judgeLoad, loadMetrics, main, parseLoadInput, percentile } from "./lib/judgeLoadDrill"

const RUN_SH = resolve(import.meta.dir, "../../devnet/quorum-drills/run.sh")
const T0 = 1_793_793_600_000

/**
 * 4 validators, blocks 10..20 every 10 s from T0, 2 transfers a second for
 * 60 s, each included in the block after it was sent and seen 3 s after that.
 */
function input(): LoadInput {
    const nodes = [1, 2, 3, 4]
    const blockTimes = Array.from({ length: 11 }, (_, k) => ({ number: 10 + k, timestamp: (T0 + k * 10_000) / 1000 }))
    const blockTimesMs: Record<string, number> = {}
    for (const b of blockTimes) blockTimesMs[String(b.number)] = b.timestamp * 1000
    const txs = Array.from({ length: 120 }, (_, k) => {
        const sentMs = T0 + 500 + k * 500
        const blockNumber = 10 + Math.ceil((sentMs - T0) / 10_000)
        return {
            w: k % 4,
            nonce: 1 + Math.floor(k / 4),
            sentMs,
            ok: true,
            hash: `h${k}`,
            includedSeenMs: blockTimesMs[String(blockNumber)] + 3000,
            blockNumber,
        }
    })
    return {
        scenario: "load-n4s4",
        validators: 4,
        shardSize: 4,
        consensusTimeS: 10,
        limits: { minIncludedRatio: 0.95, maxGapS: 110 },
        load: {
            targetTps: 2,
            durationS: 60,
            wallets: 4,
            sent: 120,
            accepted: 120,
            rejected: 0,
            throttled: 0,
            included: 120,
            tStartMs: T0 + 500,
            tSendEndMs: T0 + 60_500,
            tEndMs: T0 + 95_000,
            blockTimesMs,
            errors: [],
            txs,
        },
        startHeight: 10,
        endHeight: 20,
        tStartMs: T0,
        tEndMs: T0 + 105_000,
        blockTimes,
        heads: { 1: 20, 2: 20, 3: 21, 4: 20 },
        rows: nodes.flatMap(node => blockTimes.map(b => ({ node, number: b.number, hash: `0x${b.number}`, signatures: 4 }))),
        restartCounts: { before: { 1: 0, 2: 0, 3: 0, 4: 0 }, after: { 1: 0, 2: 0, 3: 0, 4: 0 } },
    }
}

const failed = (i: LoadInput) => judgeLoad(i).checks.filter(c => !c.pass).map(c => c.id)

describe("load metrics", () => {
    it("measures main TPS, block times and time to inclusion", () => {
        const m = loadMetrics(input())
        // 120 included between the first send (T0+0.5 s) and the block of the last (T0+60 s)
        expect(m.mainTps).toBe(2.02)
        expect(m.offeredTps).toBe(2)
        expect(m.blockTimeS).toEqual({ n: 10, p50: 10, p95: 10, max: 10 })
        expect(m.timeToInclusionS.n).toBe(120)
        expect(m.timeToInclusionS.max).toBe(12.5)
        expect(m.submitToBlockS.p95).toBe(9)
        expect(m.peakTxsPerBlock).toBe(20)
        expect(m.includedRatio).toBe(1)
        expect(m.l2psTps).toBeNull()
    })
    it("takes nearest-rank percentiles", () => {
        expect(percentile([], 50)).toBeNull()
        expect(percentile([5, 1, 3], 50)).toBe(3)
        expect(percentile([1, 2, 3, 4], 95)).toBe(4)
    })
})

describe("load verdict", () => {
    it("passes a load that lands on one chain", () => {
        const v = judgeLoad(input())
        expect(v.pass).toBe(true)
        expect(v.checks.map(c => c.id)).toEqual(["L1", "L2", "L3", "L4", "L5"])
        expect(v.summary).toContain("mainTps=2.02")
    })
    it("fails when nothing is accepted", () => {
        const i = input()
        for (const t of i.load.txs) t.ok = false
        i.load.accepted = 0
        i.load.errors = [{ message: "confirm: nonce too far ahead", count: 120 }]
        const v = judgeLoad(i)
        expect(failed(i)).toEqual(["L1"])
        expect(v.checks[0].reasons[0]).toContain("nonce too far ahead")
    })
    it("fails when too few accepted transfers are included", () => {
        const i = input()
        for (const t of i.load.txs.slice(0, 10)) t.includedSeenMs = null
        expect(failed(i)).toEqual(["L2"])
    })
    it("fails a stall longer than the limit, open to the end of the drill", () => {
        const i = input()
        i.tEndMs = T0 + 100_000 + 111_000
        const v = judgeLoad(i)
        expect(failed(i)).toEqual(["L3"])
        expect(v.checks[2].reasons[0]).toContain("to the end of the drill")
    })
    it("fails a fork, a block under quorum or a node behind", () => {
        const i = input()
        i.rows.find(r => r.node === 2 && r.number === 15)!.hash = "0xfork"
        i.rows.find(r => r.node === 1 && r.number === 16)!.signatures = 2
        i.heads[4] = 19
        const reasons = judgeLoad(i).checks.find(c => c.id === "L4")!.reasons
        expect(reasons).toContain("node-4 head 19 < target 20")
        expect(reasons.some(r => r.includes("height 15: hash divergence"))).toBe(true)
        expect(reasons.some(r => r.includes("height 16 on node-1: 2 signatures"))).toBe(true)
    })
    it("fails a node that restarted", () => {
        const i = input()
        i.restartCounts.after[3] = 1
        expect(failed(i)).toEqual(["L5"])
    })
})

describe("input and CLI", () => {
    it("refuses a malformed input", () => {
        const raw: any = input()
        delete raw.load.txs
        expect(() => parseLoadInput(raw)).toThrow("load.txs must be an array")
        expect(() => parseLoadInput({ ...input(), limits: {} })).toThrow("limits")
    })
    it("writes the verdict and exits 0 on a pass, 2 on bad input", () => {
        const dir = mkdtempSync(join(tmpdir(), "load-judge-"))
        writeFileSync(join(dir, "in.json"), JSON.stringify(input()))
        expect(main([join(dir, "in.json"), "--out", join(dir, "v.json")])).toBe(0)
        expect(JSON.parse(readFileSync(join(dir, "v.json"), "utf8")).metrics.mainTps).toBe(2.02)
        writeFileSync(join(dir, "bad.json"), "{}")
        expect(main([join(dir, "bad.json")])).toBe(2)
        expect(main([])).toBe(2)
    })
    it("is the judge run.sh calls for load-* scenarios", () => {
        const sh = readFileSync(RUN_SH, "utf8")
        expect(sh).toContain("bun testing/forks/rehearsal/lib/judgeLoadDrill.ts")
        expect(sh).toMatch(/load-\*\) scenario_load ;;/)
    })
})
