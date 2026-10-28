/**
 * A round that ends without a block records its height, and the next round
 * asks the members whether one of them committed it before building
 * anything: a fresh round at that height would build a different block.
 */

import { afterEach, describe, expect, it, mock } from "bun:test"

const reached: string[] = []
let adoptAnswer = false
let shardError: () => Error = () => new Error("unset")
const recorded: Array<[number, string[]]> = []

const realSync = await import("@/libs/blockchain/routines/Sync")
const realCommitted = await import("./routines/committedBlock")
const { BlockInvalidError, ForgingEndedError } = await import("@/errors")

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
}))
mock.module("./routines/committedBlock", () => ({
    ...realCommitted,
    adoptBeforeRetry: async (height: number) => {
        reached.push(`adoptBeforeRetry:${height}`)
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
const { consensusRoutine } = await import("./PoRBFT")

afterEach(() => {
    reached.length = 0
    recorded.length = 0
    adoptAnswer = false
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
        shardError = () => new ForgingEndedError("stop here")
        await consensusRoutine()
        expect(reached.at(-1)).toBe("initializeShard")
        // an aborted round is not a failed vote: nothing to check next time
        expect(recorded).toEqual([])
    }, 30000)

    it("records the height of a round that failed, for the next round to check", async () => {
        shardError = () => new BlockInvalidError("no quorum")
        const height = getSharedState.lastBlockNumber + 1
        await consensusRoutine()
        expect(recorded.map(([h]) => h)).toEqual([height])
    }, 30000)
})
