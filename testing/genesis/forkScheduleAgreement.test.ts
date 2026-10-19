import { describe, it, expect } from "bun:test"
import {
    checkPeerSchedule,
    compareSchedules,
    forkScheduleDigest,
    localScheduleView,
    peerScheduleView,
    type ScheduleView,
} from "src/libs/peer/routines/forkScheduleAgreement"
import { cloneDefaultForkConfig } from "src/forks/forkConfig"

const config = (patch: Record<string, number | null> = {}) => {
    const c: any = cloneDefaultForkConfig()
    c.signatureDomain.activationHeight = 40
    c.web2ProofBinding.activationHeight = 40
    for (const [k, v] of Object.entries(patch)) c[k].activationHeight = v
    return c
}
/** What a peer's getNetworkInfo says about a given configuration. */
const answer = (c: any, chainId: number | null, withDigest = true) => ({
    forks: Object.fromEntries(Object.keys(c).map(k => [k, { activationHeight: c[k].activationHeight, activated: false, currentHeight: 1 }])),
    chainId,
    ...(withDigest ? { forkScheduleDigest: forkScheduleDigest(c, chainId) } : {}),
})

describe("fork schedule digest", () => {
    it("is stable, covers every fork, and ignores descriptions", () => {
        const c = config()
        expect(forkScheduleDigest(c, 1)).toBe(forkScheduleDigest(config(), 1))
        const described = config()
        described.atomicWork.description = "reworded in another build"
        expect(forkScheduleDigest(described, 1)).toBe(forkScheduleDigest(c, 1))
        for (const name of Object.keys(c)) {
            const changed = config()
            changed[name].activationHeight = changed[name].activationHeight === 77 ? 78 : 77
            expect(forkScheduleDigest(changed, 1)).not.toBe(forkScheduleDigest(c, 1))
        }
    })

    it("covers the payload of a scheduled fork and the chain id", () => {
        const c = config({ gasFeeSeparation: 50 })
        const other = config({ gasFeeSeparation: 50 })
        other.gasFeeSeparation.treasuryAddress = "0x" + "11".repeat(32)
        expect(forkScheduleDigest(other, 1)).not.toBe(forkScheduleDigest(c, 1))
        expect(forkScheduleDigest(c, 2)).not.toBe(forkScheduleDigest(c, 1))
        expect(forkScheduleDigest(c, null)).not.toBe(forkScheduleDigest(c, 1))
    })
})

it("leaves out forks that are not scheduled, whatever their payload", () => {
    const c = config()
    const other = config()
    other.atomicWork.somePayloadField = "code default of another build"
    other.extraFork = { activationHeight: null, anything: 1 }
    expect(forkScheduleDigest(other, 1)).toBe(forkScheduleDigest(c, 1))
})

describe("comparing schedules", () => {
    const ours = localScheduleView(config(), 31337)
    const view = (c: any, id: number | null, withDigest = true) => peerScheduleView(answer(c, id, withDigest))!

    it("agrees on equal schedules", () => {
        expect(compareSchedules(ours, view(config(), 31337))).toEqual({ status: "agree" })
    })

    it("sees a difference in a fork the old three-fork comparison never looked at", () => {
        const result = compareSchedules(ours, view(config({ atomicWork: 900 }), 31337))
        expect(result.status).toBe("mismatch")
        if (result.status !== "mismatch") throw new Error("unreachable")
        expect(result.lines[0]).toMatch(/^schedule digest: ours [0-9a-f]{64}, theirs [0-9a-f]{64}$/)
        expect(result.lines).toContain("atomicWork: ours null, theirs 900")
    })

    it("names the forks and the chain id that differ", () => {
        const result = compareSchedules(ours, view(config({ signatureDomain: null, web2ProofBinding: 50 }), 1))
        if (result.status !== "mismatch") throw new Error("expected a mismatch")
        expect(result.lines).toContain("signatureDomain: ours 40, theirs null")
        expect(result.lines).toContain("web2ProofBinding: ours 40, theirs 50")
        expect(result.lines).toContain("chainId: ours 31337, theirs 1")
    })

    it("compares heights with a peer that publishes no digest: equal heights agree", () => {
        expect(compareSchedules(ours, view(config(), 31337, false))).toEqual({ status: "agree" })
    })

    it("compares heights with a peer that publishes no digest: a differing height is a mismatch naming the fork", () => {
        const result = compareSchedules(ours, view(config({ atomicWork: 900 }), 31337, false))
        if (result.status !== "mismatch") throw new Error("expected a mismatch")
        expect(result.lines).toEqual(["atomicWork: ours null, theirs 900"])
    })

    it("skips a peer that reports no fork data at all", () => {
        expect(compareSchedules(ours, peerScheduleView({ forks: {}, chainId: 31337 })!)).toEqual({ status: "skipped" })
    })

    it("reports a mismatch when the digests differ but every per-fork height and the chain id are equal", () => {
        const theirConfig = config()
        theirConfig.signatureDomain.someNewPayloadField = "only in the other build"
        const theirs = view(theirConfig, 31337)
        const result = compareSchedules(ours, theirs)
        if (result.status !== "mismatch") throw new Error("expected a mismatch")
        expect(result.lines).toHaveLength(2)
        expect(result.lines[1]).toBe(
            `scheduled fork payload or set differs (digest ${ours.digest} vs ${theirs.digest})`,
        )
    })

    it("reports a mismatch for the same scheduled fork at the same height with a different treasury address", () => {
        const mine = localScheduleView(config({ gasFeeSeparation: 50 }), 31337)
        const theirConfig = config({ gasFeeSeparation: 50 })
        theirConfig.gasFeeSeparation.treasuryAddress = "0x" + "11".repeat(32)
        const result = compareSchedules(mine, view(theirConfig, 31337))
        if (result.status !== "mismatch") throw new Error("expected a mismatch")
        expect(result.lines[0]).toMatch(/^schedule digest: ours [0-9a-f]{64}, theirs [0-9a-f]{64}$/)
        expect(result.lines[1]).toMatch(/^scheduled fork payload or set differs/)
    })

    it("does not use or print a peer digest that is not a sha256 hex string", () => {
        const hostile = peerScheduleView({
            ...answer(config({ atomicWork: 900 }), 31337),
            forkScheduleDigest: "x".repeat(10_000),
        })!
        expect(hostile.digest).toBeUndefined()
        const result = compareSchedules(ours, hostile)
        if (result.status !== "mismatch") throw new Error("expected a mismatch")
        expect(result.lines.join("\n")).not.toContain("xxxx")
    })

    it("caps what a peer supplied when it is logged", () => {
        const long = "7".repeat(500)
        const theirs: ScheduleView = { chainId: long as unknown as number, forks: { atomicWork: long as unknown as number } }
        const result = compareSchedules(ours, theirs)
        if (result.status !== "mismatch") throw new Error("expected a mismatch")
        for (const line of result.lines) expect(line.length).toBeLessThan(120)
    })

    it("drops peer values of the wrong type when reading the answer", () => {
        const view = peerScheduleView({
            forks: { atomicWork: { activationHeight: "9" }, signatureDomain: { activationHeight: 40 } },
            chainId: { nested: true },
        })!
        expect(view.forks).toEqual({ signatureDomain: 40 })
        expect(view.chainId).toBeUndefined()
    })

    it("has no view of an answer without a fork table", () => {
        expect(peerScheduleView(null)).toBeNull()
        expect(peerScheduleView("nope")).toBeNull()
        expect(peerScheduleView({})).toBeNull()
    })
})

describe("asking a peer", () => {
    const ours = localScheduleView(config(), 31337)
    const peer = (replies: Array<{ result: number; response?: unknown } | Error>) => {
        let i = 0
        return {
            calls: () => i,
            call: async () => {
                const r = replies[Math.min(i++, replies.length - 1)]
                if (r instanceof Error) throw r
                return r
            },
        }
    }
    const fast = { sleep: async () => undefined, sleepMs: 0 }

    it("treats a peer that is not ready as not ready, never as a mismatch, and asks again", async () => {
        const p = peer([{ result: 503 }, { result: 503 }, { result: 200, response: answer(config(), 31337) }])
        expect(await checkPeerSchedule(p, ours, fast)).toEqual({ status: "agree" })
        expect(p.calls()).toBe(3)
    })

    it("gives up as not-ready after the attempts", async () => {
        const p = peer([{ result: 503 }])
        expect(await checkPeerSchedule(p, ours, { ...fast, attempts: 3 })).toEqual({ status: "not-ready" })
        expect(p.calls()).toBe(3)
    })

    it("reports a real difference", async () => {
        const p = peer([{ result: 200, response: answer(config({ signatureDomain: null }), 31337) }])
        expect((await checkPeerSchedule(p, ours, fast)).status).toBe("mismatch")
    })

    it("caps what a peer put into the reason of an unreachable answer", async () => {
        const p = peer([{ result: "9".repeat(500) as unknown as number }])
        const check = await checkPeerSchedule(p, ours, fast)
        if (check.status !== "unreachable") throw new Error("expected unreachable")
        expect(check.reason.length).toBeLessThan(100)
    })

    it("reports an unreachable peer without throwing", async () => {
        const p = peer([new Error("boom")])
        expect(await checkPeerSchedule(p, ours, fast)).toEqual({ status: "unreachable", reason: "boom" })
    })
})
