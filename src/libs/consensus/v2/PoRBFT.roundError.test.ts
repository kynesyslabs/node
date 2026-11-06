/**
 * An error the round does not expect ends the round, not the node: before
 * the block commits nothing is on disk. Only a block on disk that memory has
 * not caught up with still stops the node.
 */

import { afterAll, afterEach, describe, expect, it, mock, spyOn } from "bun:test"

let roundError: () => Error = () => new Error("unset")

const realSync = await import("@/libs/blockchain/routines/Sync")
const realCommitted = await import("./routines/committedBlock")

mock.module("@/libs/blockchain/routines/Sync", () => ({
    ...realSync,
    fastSync: async () => ({ latestChainBlock: 7, ourLatestBlock: 7 }),
    waitForPeerStatus: async () => true,
    unreconciledGcrBlockNumber: () => null,
    assertNoUnreconciledGcrState: async () => undefined,
}))
mock.module("./routines/committedBlock", () => ({
    ...realCommitted,
    adoptBeforeRetry: async () => false,
    recordFailedRound: () => undefined,
    probeCommitteeForHeight: () => undefined,
}))
mock.module("./routines/getCommonValidatorSeed", () => ({
    __esModule: true,
    default: async () => {
        throw roundError()
    },
}))

const { getSharedState } = await import("src/utilities/sharedState")
const { CommittedBlockFollowUpError } = await import(
    "src/libs/blockchain/committedBlockError"
)
const { consensusRoutine } = await import("./PoRBFT")

const exitSpy = spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called")
}) as never)
afterAll(() => exitSpy.mockRestore())

getSharedState.setShardSizeFromGenesis(4)

afterEach(() => {
    exitSpy.mockClear()
    getSharedState.syncStatus = true
    getSharedState.fastSyncCount = 0
    getSharedState.inConsensusLoop = false
})

describe("an unexpected error in a round", () => {
    it("ends the round and keeps the node running on a database timeout", async () => {
        roundError = () =>
            new Error("canceling statement due to statement timeout")
        await consensusRoutine()
        expect(exitSpy).not.toHaveBeenCalled()
    }, 30000)

    it("ends the round and keeps the node running on a network error", async () => {
        roundError = () => new TypeError("fetch failed")
        await consensusRoutine()
        expect(exitSpy).not.toHaveBeenCalled()
    }, 30000)

    it("still stops the node when a committed block's follow-up failed", async () => {
        roundError = () =>
            new CommittedBlockFollowUpError(8, new Error("side effect failed"))
        await expect(consensusRoutine()).rejects.toThrow("process.exit called")
        expect(exitSpy).toHaveBeenCalledWith(1)
    }, 30000)
})
