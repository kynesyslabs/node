import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import {
    applyRoundOutcome,
    ensureWindowChecked,
    onBlockInserted,
    resetWindowCheck,
    RECHECK_INTERVAL_MS,
    type CheckPlan,
} from "src/libs/peer/routines/forkScheduleWatch"
import { getMetricsService } from "src/features/metrics/MetricsService"
import { Config } from "src/config"
import { getSharedState } from "src/utilities/sharedState"
import GCR from "src/libs/blockchain/gcr/gcr"
import {
    forkScheduleAbstainReason,
    resetForkScheduleAbstainLogThrottle,
    shouldLogForkScheduleAbstain,
} from "src/libs/consensus/v2/routines/forkScheduleAbstain"

const inWindow: CheckPlan = { due: true, inWindow: true, nearest: 1000 }
const outsideWindow: CheckPlan = { due: true, inWindow: false, nearest: 1000 }

type Gauges = Record<string, number>
let gauges: Gauges
let restoreGauge: () => void
let restoreConfig: () => void
let tick: (() => void) | null
let intervalsStarted: number[]
let intervalsCleared: number
let restoreTimers: () => void

function usePolicy(policy: "abstain" | "warn") {
    restoreConfig?.()
    const spy = spyOn(Config, "getInstance").mockReturnValue({
        core: { forkScheduleMismatchPolicy: policy },
    } as never)
    restoreConfig = () => spy.mockRestore()
}

beforeEach(() => {
    resetWindowCheck()
    getSharedState.forkScheduleAbstain = false
    getSharedState.forkScheduleAbstainReason = ""
    gauges = {}
    const spy = spyOn(getMetricsService(), "setGauge").mockImplementation(((
        name: string,
        value: number,
    ) => {
        gauges[name] = value
    }) as never)
    restoreGauge = () => spy.mockRestore()
    usePolicy("abstain")

    tick = null
    intervalsStarted = []
    intervalsCleared = 0
    const setSpy = spyOn(globalThis, "setInterval").mockImplementation(((
        fn: () => void,
        ms: number,
    ) => {
        tick = fn
        intervalsStarted.push(ms)
        return 1234
    }) as never)
    const clearSpy = spyOn(globalThis, "clearInterval").mockImplementation((() => {
        intervalsCleared++
        tick = null
    }) as never)
    restoreTimers = () => {
        setSpy.mockRestore()
        clearSpy.mockRestore()
    }
    resetForkScheduleAbstainLogThrottle()
})

afterEach(async () => {
    // Stops a recheck timer a test left running.
    await applyRoundOutcome(0, outsideWindow, { mismatched: [], agreed: 1 })
    restoreTimers()
    restoreGauge()
    restoreConfig()
    getSharedState.forkScheduleAbstain = false
    getSharedState.forkScheduleAbstainReason = ""
})

describe("a peer with a different schedule", () => {
    it("makes the node abstain inside the window and names the peers and the nearest height", async () => {
        await applyRoundOutcome(960, inWindow, {
            mismatched: ["http://a:53550", "http://b:53550"],
            agreed: 1,
        })
        expect(getSharedState.forkScheduleAbstain).toBe(true)
        expect(getSharedState.forkScheduleAbstainReason).toContain("http://a:53550")
        expect(getSharedState.forkScheduleAbstainReason).toContain("http://b:53550")
        expect(getSharedState.forkScheduleAbstainReason).toContain("nearest scheduled height 1000")
        expect(getSharedState.forkScheduleAbstainReason).toContain("2 of 3 validators")
        expect(gauges.consensus_abstaining).toBe(1)
        expect(gauges.fork_schedule_mismatch).toBe(1)
    })

    it("does not make the node abstain while it is in the majority, but still raises the gauge", async () => {
        await applyRoundOutcome(960, inWindow, { mismatched: ["http://a"], agreed: 3 })
        expect(getSharedState.forkScheduleAbstain).toBe(false)
        expect(gauges.fork_schedule_mismatch).toBe(1)
        expect(gauges.consensus_abstaining).toBeUndefined()
    })

    it("makes the node abstain when three validators differ and one agrees", async () => {
        await applyRoundOutcome(960, inWindow, {
            mismatched: ["http://a", "http://b", "http://c"],
            agreed: 1,
        })
        expect(getSharedState.forkScheduleAbstain).toBe(true)
    })

    it("does not abstain on an even split", async () => {
        await applyRoundOutcome(960, inWindow, { mismatched: ["http://a", "http://b"], agreed: 2 })
        expect(getSharedState.forkScheduleAbstain).toBe(false)
    })

    it("only raises the mismatch gauge outside the window", async () => {
        await applyRoundOutcome(300, outsideWindow, { mismatched: ["http://a"], agreed: 0 })
        expect(getSharedState.forkScheduleAbstain).toBe(false)
        expect(gauges.fork_schedule_mismatch).toBe(1)
        expect(gauges.consensus_abstaining).toBeUndefined()
    })

    it("never makes the node abstain under the warn policy", async () => {
        usePolicy("warn")
        await applyRoundOutcome(960, inWindow, { mismatched: ["http://a"], agreed: 3 })
        expect(getSharedState.forkScheduleAbstain).toBe(false)
        expect(gauges.fork_schedule_mismatch).toBe(1)
        expect(gauges.consensus_abstaining).toBeUndefined()
    })
})

describe("once the schedules agree again", () => {
    it("a clean round clears the flag and both gauges", async () => {
        await applyRoundOutcome(960, inWindow, { mismatched: ["http://a"], agreed: 0 })
        expect(getSharedState.forkScheduleAbstain).toBe(true)

        await applyRoundOutcome(970, inWindow, { mismatched: [], agreed: 3 })
        expect(getSharedState.forkScheduleAbstain).toBe(false)
        expect(getSharedState.forkScheduleAbstainReason).toBe("")
        expect(gauges.consensus_abstaining).toBe(0)
        expect(gauges.fork_schedule_mismatch).toBe(0)
    })

    it("a clean round outside the window clears it too, as after the fork activated", async () => {
        await applyRoundOutcome(960, inWindow, { mismatched: ["http://a"], agreed: 0 })
        await applyRoundOutcome(1100, { due: true, inWindow: false, nearest: null }, {
            mismatched: [],
            agreed: 1,
        })
        expect(getSharedState.forkScheduleAbstain).toBe(false)
    })

    it("a round where only a minority differs clears it, as the node is no longer the odd one out", async () => {
        await applyRoundOutcome(960, inWindow, { mismatched: ["http://a", "http://b"], agreed: 0 })
        expect(getSharedState.forkScheduleAbstain).toBe(true)
        await applyRoundOutcome(970, inWindow, { mismatched: ["http://a"], agreed: 3 })
        expect(getSharedState.forkScheduleAbstain).toBe(false)
        expect(gauges.consensus_abstaining).toBe(0)
        expect(gauges.fork_schedule_mismatch).toBe(1)
    })

    it("past the window a minority that still differs clears it, a majority keeps it, and neither sets it", async () => {
        const past: CheckPlan = { due: true, inWindow: false, nearest: null }
        await applyRoundOutcome(1100, past, { mismatched: ["http://a", "http://b"], agreed: 1 })
        expect(getSharedState.forkScheduleAbstain).toBe(false)

        await applyRoundOutcome(960, inWindow, { mismatched: ["http://a", "http://b"], agreed: 0 })
        await applyRoundOutcome(1100, past, { mismatched: ["http://a", "http://b"], agreed: 1 })
        expect(getSharedState.forkScheduleAbstain).toBe(true)
        await applyRoundOutcome(1200, past, { mismatched: ["http://a"], agreed: 2 })
        expect(getSharedState.forkScheduleAbstain).toBe(false)
    })

    it("a round that reached no peer changes nothing", async () => {
        await applyRoundOutcome(960, inWindow, { mismatched: ["http://a"], agreed: 0 })
        await applyRoundOutcome(970, inWindow, { mismatched: [], agreed: 0 })
        expect(getSharedState.forkScheduleAbstain).toBe(true)
        expect(gauges.consensus_abstaining).toBe(1)
    })

    it("a mismatch outside the window does not clear a flag raised inside it", async () => {
        await applyRoundOutcome(960, inWindow, { mismatched: ["http://a"], agreed: 0 })
        await applyRoundOutcome(1100, { due: true, inWindow: false, nearest: null }, {
            mismatched: ["http://a"],
            agreed: 0,
        })
        expect(getSharedState.forkScheduleAbstain).toBe(true)
    })
})

describe("the consensus routine's abstain check", () => {
    it("lets the node take part while the flag is down", () => {
        expect(forkScheduleAbstainReason()).toBeNull()
    })

    it("returns the reason while the flag is up", () => {
        getSharedState.forkScheduleAbstain = true
        getSharedState.forkScheduleAbstainReason = "fork schedule differs from http://a"
        expect(forkScheduleAbstainReason()).toBe("fork schedule differs from http://a")
    })

    it("still gives a reason when the text was never set", () => {
        getSharedState.forkScheduleAbstain = true
        expect(forkScheduleAbstainReason()).toContain("fork schedule")
    })
})

describe("the abstain log line", () => {
    it("is written at most once a minute", () => {
        expect(shouldLogForkScheduleAbstain(1_000)).toBe(true)
        expect(shouldLogForkScheduleAbstain(30_000)).toBe(false)
        expect(shouldLogForkScheduleAbstain(60_999)).toBe(false)
        expect(shouldLogForkScheduleAbstain(61_000)).toBe(true)
    })
})

describe("the recheck timer while abstaining", () => {
    const schedule = { signatureDomain: { activationHeight: 1000 } }

    async function withPeers<T>(
        peerCall: () => Promise<unknown>,
        body: () => Promise<T>,
    ): Promise<T> {
        const PeerManager = (await import("src/libs/peer/PeerManager")).default
        const saved = {
            forkConfig: getSharedState.forkConfig,
            chainId: getSharedState.chainId,
            last: getSharedState.lastBlockNumber,
        }
        getSharedState.forkConfig = schedule as never
        getSharedState.chainId = 1
        getSharedState.lastBlockNumber = 955
        const peers = spyOn(PeerManager, "getInstance").mockReturnValue({
            getPeers: () => [
                { identity: "peer", connection: { string: "http://peer" }, call: peerCall },
            ],
        } as never)
        const validators = spyOn(GCR, "getGCRValidatorsAtBlock").mockResolvedValue([
            { address: "peer" },
        ] as never)
        try {
            return await body()
        } finally {
            peers.mockRestore()
            validators.mockRestore()
            getSharedState.forkConfig = saved.forkConfig
            getSharedState.chainId = saved.chainId
            getSharedState.lastBlockNumber = saved.last
        }
    }

    it("starts once, every 30 seconds, when the flag is raised, and stops when it clears", async () => {
        await applyRoundOutcome(960, inWindow, { mismatched: ["http://a"], agreed: 0 })
        await applyRoundOutcome(970, inWindow, { mismatched: ["http://a"], agreed: 0 })
        expect(intervalsStarted).toEqual([RECHECK_INTERVAL_MS])
        expect(RECHECK_INTERVAL_MS).toBe(30_000)
        expect(intervalsCleared).toBe(0)

        await applyRoundOutcome(980, inWindow, { mismatched: [], agreed: 1 })
        expect(intervalsCleared).toBe(1)
    })

    it("does not start when the node does not abstain", async () => {
        await applyRoundOutcome(960, inWindow, { mismatched: ["http://a"], agreed: 2 })
        expect(intervalsStarted).toEqual([])
    })

    it("lets the flag clear on a tick with no new block once the peers agree", async () => {
        const ours = (await import("src/libs/peer/routines/forkScheduleAgreement")).localScheduleView(
            schedule as never,
            1,
        )
        let theirDigest = "b".repeat(64)
        const answer = async () => ({
            result: 200,
            response: {
                chainId: 1,
                forks: { signatureDomain: { activationHeight: 1000 } },
                forkScheduleDigest: theirDigest,
            },
        })
        await withPeers(answer, async () => {
            await applyRoundOutcome(950, inWindow, { mismatched: ["http://peer"], agreed: 0 })
            expect(getSharedState.forkScheduleAbstain).toBe(true)
            const fire = tick!
            expect(typeof fire).toBe("function")

            fire()
            await new Promise(r => setTimeout(r, 200))
            expect(getSharedState.forkScheduleAbstain).toBe(true)

            theirDigest = ours.digest as string
            fire()
            await waitFor(() => !getSharedState.forkScheduleAbstain)
            expect(intervalsCleared).toBeGreaterThan(0)
            expect(gauges.consensus_abstaining).toBe(0)
        })
    }, 30000)

    it("skips a tick while a round is still running and never throws", async () => {
        const releases: Array<() => void> = []
        let asked = 0
        const hang = () => {
            asked++
            return new Promise(resolve => releases.push(() => resolve({ result: 503 })))
        }
        await withPeers(hang, async () => {
            await applyRoundOutcome(950, inWindow, { mismatched: ["http://peer"], agreed: 0 })
            const fire = tick!
            const first = onBlockInserted(950)
            await waitFor(() => asked === 1)
            expect(() => fire()).not.toThrow()
            await new Promise(r => setTimeout(r, 100))
            expect(asked).toBe(1)
            releases.shift()!()
            await first
        })
    }, 30000)

    it("swallows a failing comparison", async () => {
        const PeerManager = (await import("src/libs/peer/PeerManager")).default
        await applyRoundOutcome(950, inWindow, { mismatched: ["http://peer"], agreed: 0 })
        const fire = tick!
        const peers = spyOn(PeerManager, "getInstance").mockImplementation((() => {
            throw new Error("peer manager down")
        }) as never)
        try {
            expect(() => fire()).not.toThrow()
            await new Promise(r => setTimeout(r, 100))
            expect(getSharedState.forkScheduleAbstain).toBe(true)
        } finally {
            peers.mockRestore()
        }
    })
})

describe("the watch end to end", () => {
    it("raises the flag on a differing peer inside the window and drops it when the peer agrees", async () => {
        const PeerManager = (await import("src/libs/peer/PeerManager")).default
        const agreement = await import("src/libs/peer/routines/forkScheduleAgreement")
        const saved = {
            forkConfig: getSharedState.forkConfig,
            chainId: getSharedState.chainId,
        }
        getSharedState.forkConfig = {
            signatureDomain: { activationHeight: 1000 },
        } as never
        getSharedState.chainId = 1
        const ours = agreement.localScheduleView(getSharedState.forkConfig as never, 1)

        let theirDigest = "a".repeat(64)
        const peer = {
            identity: "peer",
            connection: { string: "http://peer:53550" },
            call: async () => ({
                result: 200,
                response: {
                    chainId: 1,
                    forks: { signatureDomain: { activationHeight: 1000 } },
                    forkScheduleDigest: theirDigest,
                },
            }),
        }
        const getPeers = spyOn(PeerManager, "getInstance").mockReturnValue({
            getPeers: () => [peer],
        } as never)
        const validators = spyOn(GCR, "getGCRValidatorsAtBlock").mockResolvedValue([
            { address: "peer" },
        ] as never)

        try {
            await onBlockInserted(950)
            expect(getSharedState.forkScheduleAbstain).toBe(true)
            expect(getSharedState.forkScheduleAbstainReason).toContain("http://peer:53550")

            theirDigest = ours.digest as string
            await onBlockInserted(960)
            expect(getSharedState.forkScheduleAbstain).toBe(false)
            expect(gauges.consensus_abstaining).toBe(0)
        } finally {
            getPeers.mockRestore()
            validators.mockRestore()
            getSharedState.forkConfig = saved.forkConfig
            getSharedState.chainId = saved.chainId
        }
    }, 30000)

    it("ignores a peer that is not a staked validator, however many of them differ", async () => {
        const PeerManager = (await import("src/libs/peer/PeerManager")).default
        const saved = {
            forkConfig: getSharedState.forkConfig,
            chainId: getSharedState.chainId,
        }
        getSharedState.forkConfig = {
            signatureDomain: { activationHeight: 1000 },
        } as never
        getSharedState.chainId = 1
        const ours = (await import("src/libs/peer/routines/forkScheduleAgreement")).localScheduleView(
            getSharedState.forkConfig as never,
            1,
        )
        const answering = (digest: string) => async () => ({
            result: 200,
            response: {
                chainId: 1,
                forks: { signatureDomain: { activationHeight: 1000 } },
                forkScheduleDigest: digest,
            },
        })
        const mk = (identity: string, digest: string) => ({
            identity,
            connection: { string: "http://" + identity },
            call: answering(digest),
        })
        const peers = [
            mk("validator", ours.digest as string),
            mk("outsider1", "c".repeat(64)),
            mk("outsider2", "c".repeat(64)),
            mk("outsider3", "c".repeat(64)),
        ]
        const getPeers = spyOn(PeerManager, "getInstance").mockReturnValue({
            getPeers: () => peers,
        } as never)
        const validators = spyOn(GCR, "getGCRValidatorsAtBlock").mockResolvedValue([
            { address: "Validator" },
        ] as never)
        try {
            await onBlockInserted(950)
            expect(getSharedState.forkScheduleAbstain).toBe(false)
            expect(gauges.fork_schedule_mismatch).toBe(0)
        } finally {
            getPeers.mockRestore()
            validators.mockRestore()
            getSharedState.forkConfig = saved.forkConfig
            getSharedState.chainId = saved.chainId
        }
    }, 30000)
})

describe("the check before the first round inside the window", () => {
    async function withPeers(
        digestOf: (ours: string) => string,
        run: (calls: () => number) => Promise<void>,
    ) {
        const PeerManager = (await import("src/libs/peer/PeerManager")).default
        const agreement = await import("src/libs/peer/routines/forkScheduleAgreement")
        const saved = {
            forkConfig: getSharedState.forkConfig,
            chainId: getSharedState.chainId,
        }
        getSharedState.forkConfig = {
            signatureDomain: { activationHeight: 1000 },
        } as never
        getSharedState.chainId = 1
        const ours = agreement.localScheduleView(getSharedState.forkConfig as never, 1)
        let called = 0
        const peer = {
            identity: "peer",
            connection: { string: "http://peer:53550" },
            call: async () => {
                called++
                return {
                    result: 200,
                    response: {
                        chainId: 1,
                        forks: { signatureDomain: { activationHeight: 1000 } },
                        forkScheduleDigest: digestOf(ours.digest as string),
                    },
                }
            },
        }
        const getPeers = spyOn(PeerManager, "getInstance").mockReturnValue({
            getPeers: () => [peer],
        } as never)
        const validators = spyOn(GCR, "getGCRValidatorsAtBlock").mockResolvedValue([
            { address: "peer" },
        ] as never)
        try {
            await run(() => called)
        } finally {
            getPeers.mockRestore()
            validators.mockRestore()
            getSharedState.forkConfig = saved.forkConfig
            getSharedState.chainId = saved.chainId
        }
    }

    it("raises the flag for a restarted node before any block is inserted", async () => {
        await withPeers(() => "a".repeat(64), async () => {
            expect(getSharedState.forkScheduleAbstain).toBe(false)
            await ensureWindowChecked(999)
            expect(getSharedState.forkScheduleAbstain).toBe(true)
            expect(getSharedState.forkScheduleAbstainReason).toContain("http://peer:53550")
        })
    }, 30000)

    it("leaves the flag down when the validators agree, and does not ask again for the same height", async () => {
        await withPeers(ours => ours, async calls => {
            await ensureWindowChecked(999)
            expect(getSharedState.forkScheduleAbstain).toBe(false)
            expect(calls()).toBe(1)
            await ensureWindowChecked(999)
            await ensureWindowChecked(1000 - 1)
            expect(calls()).toBe(1)
        })
    }, 30000)

    it("does nothing outside the window", async () => {
        await withPeers(() => "a".repeat(64), async calls => {
            await ensureWindowChecked(100)
            expect(calls()).toBe(0)
            expect(getSharedState.forkScheduleAbstain).toBe(false)
        })
    }, 30000)

    it("does nothing under the warn policy", async () => {
        usePolicy("warn")
        await withPeers(() => "a".repeat(64), async calls => {
            await ensureWindowChecked(999)
            expect(calls()).toBe(0)
            expect(getSharedState.forkScheduleAbstain).toBe(false)
        })
    }, 30000)

    it("retries on the next call when no validator answered", async () => {
        const PeerManager = (await import("src/libs/peer/PeerManager")).default
        const saved = getSharedState.forkConfig
        getSharedState.forkConfig = {
            signatureDomain: { activationHeight: 1000 },
        } as never
        const getPeers = spyOn(PeerManager, "getInstance").mockReturnValue({
            getPeers: () => [],
        } as never)
        const validators = spyOn(GCR, "getGCRValidatorsAtBlock").mockResolvedValue([
            { address: "peer" },
        ] as never)
        try {
            await ensureWindowChecked(999)
            expect(getSharedState.forkScheduleAbstain).toBe(false)
            await ensureWindowChecked(999)
            expect(getPeers).toHaveBeenCalledTimes(2)
        } finally {
            getPeers.mockRestore()
            validators.mockRestore()
            getSharedState.forkConfig = saved
        }
    }, 30000)

    it("waits for a round that is already running instead of starting another", async () => {
        await withPeers(() => "a".repeat(64), async calls => {
            const inserted = onBlockInserted(950)
            await ensureWindowChecked(999)
            await inserted
            expect(calls()).toBe(1)
            expect(getSharedState.forkScheduleAbstain).toBe(true)
        })
    }, 30000)
})

async function waitFor(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 300 && !cond(); i++) {
        await new Promise(r => setTimeout(r, 10))
    }
    expect(cond()).toBe(true)
}
