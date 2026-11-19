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

/** The tip the comparisons are made at; forks scheduled at or below it are active. */
const TIP = 100

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
        expect(compareSchedules(ours, view(config(), 31337), TIP)).toEqual({ status: "agree" })
    })

    it("sees a difference in a fork the old three-fork comparison never looked at", () => {
        const result = compareSchedules(ours, view(config({ atomicWork: 900 }), 31337), TIP)
        expect(result.status).toBe("mismatch")
        if (result.status !== "mismatch") throw new Error("unreachable")
        expect(result.lines[0]).toMatch(/^schedule digest: ours [0-9a-f]{64}, theirs [0-9a-f]{64}$/)
        expect(result.lines).toContain("atomicWork: ours null, theirs 900")
    })

    it("names the forks and the chain id that differ", () => {
        const result = compareSchedules(ours, view(config({ signatureDomain: null, web2ProofBinding: 50 }), 1), TIP)
        if (result.status !== "mismatch") throw new Error("expected a mismatch")
        expect(result.lines).toContain("signatureDomain: ours 40, theirs null")
        expect(result.lines).toContain("web2ProofBinding: ours 40, theirs 50")
        expect(result.lines).toContain("chainId: ours 31337, theirs 1")
    })

    it("compares heights with a peer that publishes no digest: equal heights agree", () => {
        expect(compareSchedules(ours, view(config(), 31337, false), TIP)).toEqual({ status: "agree" })
    })

    it("compares heights with a peer that publishes no digest: a differing height is a mismatch naming the fork", () => {
        const result = compareSchedules(ours, view(config({ atomicWork: 900 }), 31337, false), TIP)
        if (result.status !== "mismatch") throw new Error("expected a mismatch")
        expect(result.lines).toEqual(["atomicWork: ours null, theirs 900"])
    })

    describe("a fork already active on either side", () => {
        // Mainnet activates every fork at genesis, so no height lies ahead of the tip.
        const genesis = () => {
            const c: any = cloneDefaultForkConfig()
            for (const name of Object.keys(c)) c[name].activationHeight = 0
            return c
        }
        const mine = localScheduleView(genesis(), 31337)
        const mismatch = (theirs: ScheduleView, tip = TIP) => {
            const result = compareSchedules(mine, theirs, tip)
            if (result.status !== "mismatch") throw new Error("expected a mismatch")
            return result
        }

        it("marks a fork active here and not scheduled there as a split now", () => {
            const theirs = genesis()
            theirs.signatureDomain.activationHeight = null
            expect(mismatch(view(theirs, 31337)).activeForkDiffers).toBe(true)
        })

        it("marks a fork active here and scheduled ahead there as a split now", () => {
            const theirs = genesis()
            theirs.atomicWork.activationHeight = 500
            expect(mismatch(view(theirs, 31337)).activeForkDiffers).toBe(true)
        })

        it("marks a fork active only there, and one their registry lacks, as a split now", () => {
            const late = localScheduleView(config({ atomicWork: null }), 31337)
            const theirs = compareSchedules(late, view(config({ atomicWork: 10 }), 31337), TIP)
            expect(theirs.status === "mismatch" && theirs.activeForkDiffers).toBe(true)

            const older = genesis()
            delete older.atomicWork
            expect(mismatch(view(older, 31337)).activeForkDiffers).toBe(true)
        })

        it("does not mark a difference that lies wholly ahead of the tip", () => {
            const result = compareSchedules(ours, view(config({ atomicWork: 900 }), 31337), TIP)
            if (result.status !== "mismatch") throw new Error("expected a mismatch")
            expect(result.activeForkDiffers).toBeUndefined()
        })

        it("says nothing about a fork a peer without a digest does not report", () => {
            const a: any = answer(genesis(), 31337, false)
            delete a.forks.atomicWork
            a.forks.signatureDomain.activationHeight = 7
            const result = mismatch(peerScheduleView(a)!)
            expect(result.lines).toEqual(["signatureDomain: ours 0, theirs 7"])
            expect(result.activeForkDiffers).toBe(true)
            delete a.forks.signatureDomain
            expect(compareSchedules(mine, peerScheduleView(a)!, TIP)).toEqual({ status: "agree" })
        })
    })

    it("skips a peer that reports no fork data at all", () => {
        expect(compareSchedules(ours, peerScheduleView({ forks: {}, chainId: 31337 })!, TIP)).toEqual({ status: "skipped" })
    })

    it("reports a mismatch when the digests differ but every per-fork height and the chain id are equal", () => {
        const theirConfig = config()
        theirConfig.signatureDomain.someNewPayloadField = "only in the other build"
        const theirs = view(theirConfig, 31337)
        const result = compareSchedules(ours, theirs, TIP)
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
        const result = compareSchedules(mine, view(theirConfig, 31337), TIP)
        if (result.status !== "mismatch") throw new Error("expected a mismatch")
        expect(result.lines[0]).toMatch(/^schedule digest: ours [0-9a-f]{64}, theirs [0-9a-f]{64}$/)
        expect(result.lines[1]).toMatch(/^scheduled fork payload or set differs/)
    })

    describe("with the treasury published beside gasFeeSeparation", () => {
        const OTHER = "0x" + "11".repeat(32)
        /** What a build that publishes the treasury answers. */
        const published = (c: any, id: number) => {
            const a: any = answer(c, id)
            a.forks.gasFeeSeparation.treasuryAddress = c.gasFeeSeparation.treasuryAddress
            return peerScheduleView(a)!
        }
        const scheduled = (treasury?: string) => {
            const c = config({ gasFeeSeparation: 0 })
            if (treasury) c.gasFeeSeparation.treasuryAddress = treasury
            return c
        }

        it("names a different treasury and marks the mismatch as one", () => {
            const mine = localScheduleView(scheduled(), 31337)
            const theirs = published(scheduled(OTHER), 31337)
            const result = compareSchedules(mine, theirs, TIP)
            if (result.status !== "mismatch") throw new Error("expected a mismatch")
            expect(result.treasuryDiffers).toBe(true)
            expect(result.lines).toContain(
                `gasFeeSeparation.treasuryAddress: ours ${mine.treasuryAddress}, theirs ${OTHER}`,
            )
            expect(result.lines.join("\n")).not.toContain("payload or set differs")
        })

        it("treats a treasury difference ahead of the tip as an ordinary mismatch, and as a split once both apply the fork", () => {
            const future = (treasury?: string) => {
                const c = config({ gasFeeSeparation: 1000 })
                if (treasury) c.gasFeeSeparation.treasuryAddress = treasury
                return c
            }
            const mine = localScheduleView(future(), 31337)
            const theirs = published(future(OTHER), 31337)

            const ahead = compareSchedules(mine, theirs, 300)
            if (ahead.status !== "mismatch") throw new Error("expected a mismatch")
            expect(ahead.treasuryDiffers).toBeUndefined()
            expect(ahead.lines).toContain(
                `gasFeeSeparation.treasuryAddress: ours ${mine.treasuryAddress}, theirs ${OTHER}`,
            )

            const active = compareSchedules(mine, theirs, 1000)
            if (active.status !== "mismatch") throw new Error("expected a mismatch")
            expect(active.treasuryDiffers).toBe(true)
        })

        it("does not mark it a split while only one side applies the fork", () => {
            const early = config({ gasFeeSeparation: 0 })
            const late = config({ gasFeeSeparation: 1000 })
            late.gasFeeSeparation.treasuryAddress = OTHER
            const result = compareSchedules(localScheduleView(early, 31337), published(late, 31337), 300)
            if (result.status !== "mismatch") throw new Error("expected a mismatch")
            expect(result.treasuryDiffers).toBeUndefined()
        })

        it("compares the treasury without regard to case", () => {
            const c = scheduled(OTHER)
            const a: any = answer(c, 31337)
            a.forks.gasFeeSeparation.treasuryAddress = OTHER.toUpperCase().replace("0X", "0x")
            const theirs = peerScheduleView(a)!
            expect(theirs.treasuryAddress).toBe(OTHER)
            expect(compareSchedules(localScheduleView(c, 31337), theirs, TIP)).toEqual({ status: "agree" })
        })

        it("does not mark a mismatch elsewhere as a treasury one", () => {
            const mine = localScheduleView(scheduled(), 31337)
            const theirs = published(config({ gasFeeSeparation: 0, atomicWork: 900 }), 31337)
            const result = compareSchedules(mine, theirs, TIP)
            if (result.status !== "mismatch") throw new Error("expected a mismatch")
            expect(result.treasuryDiffers).toBeUndefined()
        })

        it("does not mark it when either side leaves gasFeeSeparation off", () => {
            const off = config({ gasFeeSeparation: null })
            off.gasFeeSeparation.treasuryAddress = OTHER
            const result = compareSchedules(localScheduleView(scheduled(), 31337), published(off, 31337), TIP)
            if (result.status !== "mismatch") throw new Error("expected a mismatch")
            expect(result.treasuryDiffers).toBeUndefined()
        })

        it("leaves a peer that publishes no treasury to the digest, and ignores one that is not an address", () => {
            const mine = localScheduleView(scheduled(), 31337)
            const old = compareSchedules(mine, view(scheduled(OTHER), 31337), TIP)
            if (old.status !== "mismatch") throw new Error("expected a mismatch")
            expect(old.treasuryDiffers).toBeUndefined()
            const a: any = answer(scheduled(OTHER), 31337)
            a.forks.gasFeeSeparation.treasuryAddress = "x".repeat(500)
            expect(peerScheduleView(a)!.treasuryAddress).toBeUndefined()
        })
    })

    it("does not use or print a peer digest that is not a sha256 hex string", () => {
        const hostile = peerScheduleView({
            ...answer(config({ atomicWork: 900 }), 31337),
            forkScheduleDigest: "x".repeat(10_000),
        })!
        expect(hostile.digest).toBeUndefined()
        const result = compareSchedules(ours, hostile, TIP)
        if (result.status !== "mismatch") throw new Error("expected a mismatch")
        expect(result.lines.join("\n")).not.toContain("xxxx")
    })

    it("caps what a peer supplied when it is logged", () => {
        const long = "7".repeat(500)
        const theirs: ScheduleView = { chainId: long as unknown as number, forks: { atomicWork: long as unknown as number } }
        const result = compareSchedules(ours, theirs, TIP)
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
    const fast = { sleep: async () => undefined, sleepMs: 0, tip: TIP }

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
