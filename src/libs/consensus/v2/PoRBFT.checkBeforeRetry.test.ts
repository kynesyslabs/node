/**
 * A round that ends without a block records its height, and the next round
 * asks the members whether one of them committed it before building
 * anything: a fresh round at that height would build a different block.
 */

import { afterAll, afterEach, describe, expect, it, mock, spyOn } from "bun:test"

const reached: string[] = []
let adoptAnswer = false
let adoptThrows = false
let undoFails = false
let latchedDrift: number | null = null
let durableDrift = false
let shardError: () => Error = () => new Error("unset")
const recorded: Array<[number, string[]]> = []

const realSync = await import("@/libs/blockchain/routines/Sync")
const realCommitted = await import("./routines/committedBlock")
const errors = await import("@/errors")

mock.module("@/libs/blockchain/routines/Sync", () => ({
    ...realSync,
    fastSync: async () => {
        reached.push("fastSync")
        return { latestChainBlock: 7, ourLatestBlock: 7 }
    },
    waitForPeerStatus: async () => {
        reached.push("waitForPeerStatus")
        return true
    },
    unreconciledGcrBlockNumber: () => latchedDrift,
    assertNoUnreconciledGcrState: async () => {
        reached.push("durableCheck")
        if (durableDrift) {
            // the real check latches what it cannot roll back
            latchedDrift = 9
            throw new Error("GCR state for block 9 exists but the block does not")
        }
    },
}))
mock.module("./routines/committedBlock", () => ({
    ...realCommitted,
    adoptBeforeRetry: async (height: number) => {
        reached.push(`adoptBeforeRetry:${height}`)
        if (undoFails) {
            // syncBlock latches the drift when it cannot undo a failed apply
            latchedDrift = height
            throw new Error(`rollback of block ${height} failed`)
        }
        if (adoptThrows) throw new Error("block 6 bodies missing from a")
        return adoptAnswer
    },
    recordFailedRound: (height: number, members: string[]) => {
        recorded.push([height, members])
    },
}))
mock.module("./routines/getCommonValidatorSeed", () => ({
    __esModule: true,
    default: async () => {
        reached.push("initializeShard")
        throw shardError()
    },
}))

const { getSharedState } = await import("src/utilities/sharedState")
const { default: log } = await import("src/utilities/logger")
const { consensusRoutine } = await import("./PoRBFT")

const exitSpy = spyOn(process, "exit").mockImplementation((() => {
    reached.push("process.exit")
    throw new Error("process.exit called")
}) as never)
afterAll(() => exitSpy.mockRestore())

afterEach(() => {
    reached.length = 0
    recorded.length = 0
    adoptAnswer = false
    adoptThrows = false
    undoFails = false
    latchedDrift = null
    durableDrift = false
    getSharedState.syncStatus = true
    // set after syncStatus, whose setter counts a successful fast sync
    getSharedState.fastSyncCount = 0
    getSharedState.inConsensusLoop = false
})

describe("check before retry", () => {
    it("ends the round without building a block when a member's block was adopted", async () => {
        adoptAnswer = true
        const height = getSharedState.lastBlockNumber + 1
        await consensusRoutine()
        expect(reached).toEqual([
            "fastSync",
            "waitForPeerStatus",
            `adoptBeforeRetry:${height}`,
        ])
        expect(getSharedState.inConsensusLoop).toBe(false)
    }, 30000)

    it("goes on to build the block when no member holds it", async () => {
        shardError = () => new errors.ForgingEndedError("stop here")
        await consensusRoutine()
        expect(reached.at(-1)).toBe("initializeShard")
        // an aborted round is not a failed vote: nothing to check next time
        expect(recorded).toEqual([])
    }, 30000)

    it("records the height of a round that failed, for the next round to check", async () => {
        shardError = () => new errors.BlockInvalidError("no quorum")
        const height = getSharedState.lastBlockNumber + 1
        await consensusRoutine()
        expect(recorded.map(([h]) => h)).toEqual([height])
    }, 30000)

    it("goes on with its own round, without exiting, when taking the block throws", async () => {
        adoptThrows = true
        shardError = () => new errors.ForgingEndedError("stop here")
        await consensusRoutine()
        expect(reached.at(-1)).toBe("initializeShard")
        expect(reached).not.toContain("process.exit")
    }, 30000)

    it("aborts without building or applying a block when the failed adoption could not be undone", async () => {
        undoFails = true
        shardError = () => new errors.ForgingEndedError("stop here")
        const height = getSharedState.lastBlockNumber + 1
        await consensusRoutine()
        expect(reached).toEqual([
            "fastSync",
            "waitForPeerStatus",
            `adoptBeforeRetry:${height}`,
        ])
        expect(reached).not.toContain("process.exit")
        expect(getSharedState.syncStatus).toBe(false)
        // No shard was formed yet, so there are no members to ask next time:
        // the real recordFailedRound keeps nothing for an empty list
        expect(recorded).toEqual([[height, []]])
        expect(getSharedState.inConsensusLoop).toBe(false)
    }, 30000)

    it("does not join the round while the drift latch is set, and warns once per height", async () => {
        latchedDrift = 6
        getSharedState.fastSyncCount = 1
        const warning = spyOn(log, "warning")
        try {
            await consensusRoutine()
            await consensusRoutine()
            expect(reached).toEqual(["fastSync", "fastSync"])
            expect(getSharedState.syncStatus).toBe(false)
            const drift = warning.mock.calls.filter(call =>
                String(call[0]).includes("Operator action needed"),
            )
            expect(drift).toHaveLength(1)
            expect(reached).not.toContain("process.exit")
        } finally {
            warning.mockRestore()
        }
    }, 30000)

    it("aborts before joining the round when durable state holds edits without their block", async () => {
        durableDrift = true
        getSharedState.fastSyncCount = 1
        const height = getSharedState.lastBlockNumber + 1
        await consensusRoutine()
        expect(reached).toEqual(["fastSync", "durableCheck"])
        expect(reached).not.toContain("process.exit")
        expect(recorded).toEqual([[height, []]])
        expect(getSharedState.inConsensusLoop).toBe(false)
    }, 30000)

    it("leaves the durable check to sync until the first fast sync has succeeded", async () => {
        durableDrift = true
        shardError = () => new errors.ForgingEndedError("stop here")
        await consensusRoutine()
        expect(reached).not.toContain("durableCheck")
        expect(reached.at(-1)).toBe("initializeShard")
    }, 30000)
})
