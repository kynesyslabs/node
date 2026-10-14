import { describe, it, expect } from "bun:test"
import {
    checkPeerSchedule,
    compareSchedules,
    forkScheduleDigest,
    localScheduleView,
    peerScheduleView,
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

    it("covers payloads and the chain id", () => {
        const c = config()
        const other = config()
        other.gasFeeSeparation.treasuryAddress = "0x" + "11".repeat(32)
        expect(forkScheduleDigest(other, 1)).not.toBe(forkScheduleDigest(c, 1))
        expect(forkScheduleDigest(c, 2)).not.toBe(forkScheduleDigest(c, 1))
        expect(forkScheduleDigest(c, null)).not.toBe(forkScheduleDigest(c, 1))
    })
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

    it("skips a peer that publishes no digest", () => {
        expect(compareSchedules(ours, view(config({ atomicWork: 900 }), 1, false))).toEqual({ status: "skipped" })
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

    it("reports an unreachable peer without throwing", async () => {
        const p = peer([new Error("boom")])
        expect(await checkPeerSchedule(p, ours, fast)).toEqual({ status: "unreachable", reason: "boom" })
    })
})
