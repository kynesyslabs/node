import { afterEach, describe, expect, it, mock } from "bun:test"

// The abort must come right after the sync step and before anything that
// forges or votes, so the stubs record which of those steps were reached.
const reached: string[] = []

const realSync = await import("@/libs/blockchain/routines/Sync")

mock.module("@/libs/blockchain/routines/Sync", () => ({
    ...realSync,
    fastSync: async () => {
        reached.push("fastSync")
        return { latestChainBlock: 7, ourLatestBlock: 7 }
    },
    waitForPeerStatus: async () => {
        reached.push("waitForPeerStatus")
        return false
    },
    syncLock: async () => () => undefined,
}))

const { getSharedState } = await import("src/utilities/sharedState")
const { consensusRoutine } = await import("src/libs/consensus/v2/PoRBFT")
const { default: log } = await import("src/utilities/logger")
const { resetForkScheduleAbstainLogThrottle } = await import(
    "src/libs/consensus/v2/routines/forkScheduleAbstain"
)

afterEach(() => {
    reached.length = 0
    resetForkScheduleAbstainLogThrottle()
    getSharedState.forkScheduleAbstain = false
    getSharedState.forkScheduleAbstainReason = ""
    getSharedState.inConsensusLoop = false
})

describe("the consensus routine while the fork schedule flag is up", () => {
    it("syncs, then aborts the round before it touches the shard, with one error line", async () => {
        getSharedState.forkScheduleAbstain = true
        getSharedState.forkScheduleAbstainReason =
            "fork schedule differs from http://a (nearest scheduled height 1000)"
        const lines: string[] = []
        const original = log.error
        log.error = ((msg: string) => {
            lines.push(String(msg))
        }) as typeof log.error
        try {
            await consensusRoutine()
        } finally {
            log.error = original
        }
        expect(reached).toEqual(["fastSync"])
        const abort = lines.filter(l => l.includes("Abstaining from block"))
        expect(abort).toHaveLength(1)
        expect(abort[0]).toContain("http://a")
        expect(abort[0]).toContain("nearest scheduled height 1000")
        expect(getSharedState.inConsensusLoop).toBe(false)
    }, 30000)

    it("logs the abort once a minute, not once per round", async () => {
        getSharedState.forkScheduleAbstain = true
        getSharedState.forkScheduleAbstainReason = "fork schedule differs from http://a"
        const lines: string[] = []
        const original = log.error
        log.error = ((msg: string) => {
            lines.push(String(msg))
        }) as typeof log.error
        try {
            await consensusRoutine()
            await consensusRoutine()
            await consensusRoutine()
        } finally {
            log.error = original
        }
        expect(reached).toEqual(["fastSync", "fastSync", "fastSync"])
        expect(lines.filter(l => l.includes("Abstaining from block"))).toHaveLength(1)
    }, 30000)

    it("goes on to the peer check once the flag is down", async () => {
        await consensusRoutine()
        expect(reached).toEqual(["fastSync", "waitForPeerStatus"])
    }, 30000)
})
