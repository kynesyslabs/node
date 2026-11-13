/**
 * An error the round does not expect ends the round, not the node: before
 * the block commits nothing is on disk. Only a block on disk that memory has
 * not caught up with still stops the node, through the graceful shutdown.
 */

import { afterAll, afterEach, describe, expect, it, jest, mock, spyOn } from "bun:test"
import log from "src/utilities/logger"
import Chain from "src/libs/blockchain/chain"

let roundError: () => Error = () => new Error("unset")
const checkGcr = jest.fn(async () => undefined)

const gracefulShutdown = jest.fn(async (_signal: string, _exitCode?: number) => {})
mock.module("src/index", () => ({ gracefulShutdown }))

const realSync = await import("@/libs/blockchain/routines/Sync")
const realCommitted = await import("./routines/committedBlock")
const realNonceTrace = await import("@/libs/debug/nonceTrace")
let debugAssertions = false
mock.module("@/libs/debug/nonceTrace", () => ({
    ...realNonceTrace,
    debugAssertionsEnabled: () => debugAssertions,
}))

mock.module("@/libs/blockchain/routines/Sync", () => ({
    ...realSync,
    fastSync: async () => ({ latestChainBlock: 7, ourLatestBlock: 7 }),
    waitForPeerStatus: async () => true,
    unreconciledGcrBlockNumber: () => null,
    assertNoUnreconciledGcrState: checkGcr,
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
const {
    BlockCommitUnknownError,
    CommittedBlockFollowUpError,
    stopAfterCommittedBlockFailure,
} = await import(
    "src/libs/blockchain/committedBlockError"
)
const { haltSigning, signingHaltReason, __resetSigningHalt } = await import(
    "src/libs/identity/signingRecord"
)
const { consensusRoutine } = await import("./PoRBFT")

const exitSpy = spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called")
}) as never)
afterAll(() => exitSpy.mockRestore())

getSharedState.setShardSizeFromGenesis(4)

afterEach(() => {
    exitSpy.mockClear()
    gracefulShutdown.mockClear()
    checkGcr.mockClear()
    __resetSigningHalt()
    getSharedState.syncStatus = true
    getSharedState.fastSyncCount = 0
    getSharedState.inConsensusLoop = false
    getSharedState.runMainLoop = true
})

describe("an unexpected error in a round", () => {
    it("does not run a peer-started round or roll back GCR after a committed block failure", async () => {
        getSharedState.fastSyncCount = 1
        stopAfterCommittedBlockFailure(
            new CommittedBlockFollowUpError(8, new Error("side effect failed")),
        )
        await consensusRoutine()
        expect(checkGcr).not.toHaveBeenCalled()
        expect(getSharedState.runMainLoop).toBe(false)
    })

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

    it("still stops the node when a committed block's follow-up failed, gracefully and with signing stopped", async () => {
        const logSpy = spyOn(log, "error").mockImplementation(() => undefined as any)
        roundError = () => new CommittedBlockFollowUpError(8, new Error("side effect failed"))
        await consensusRoutine()
        await new Promise(resolve => setTimeout(resolve, 0))

        expect(exitSpy).not.toHaveBeenCalled()
        expect(signingHaltReason()).toContain("Block 8 committed")
        expect(gracefulShutdown).toHaveBeenCalledWith("committed_block_follow_up", 1)
        expect(getSharedState.inConsensusLoop).toBe(false)
        expect(getSharedState.runMainLoop).toBe(false)
        expect(logSpy).toHaveBeenCalledWith("[SIGNING] stopped until this process exits: Block 8 committed but its follow-up failed: Error: side effect failed")
        logSpy.mockRestore()
    }, 30000)

    it("stops the node the same way when the block's commit outcome is unknown", async () => {
        const logSpy = spyOn(log, "error").mockImplementation(() => undefined as any)
        roundError = () => new BlockCommitUnknownError(8, new Error("connection lost during COMMIT"))
        await consensusRoutine()
        await new Promise(resolve => setTimeout(resolve, 0))

        expect(exitSpy).not.toHaveBeenCalled()
        expect(signingHaltReason()).toContain("Block 8 may have committed")
        expect(gracefulShutdown).toHaveBeenCalledWith("committed_block_follow_up", 1)
        expect(logSpy).toHaveBeenCalledWith("[SIGNING] stopped until this process exits: Block 8 may have committed: Error: connection lost during COMMIT")
        logSpy.mockRestore()
    }, 30000)

    it("keeps an earlier signing halt reason and logs that signing was already stopped", async () => {
        const logSpy = spyOn(log, "error").mockImplementation(() => undefined as any)
        haltSigning("another process signed with this key")
        stopAfterCommittedBlockFailure(new BlockCommitUnknownError(8, "lost COMMIT reply"))
        await new Promise(resolve => setTimeout(resolve, 0))

        expect(signingHaltReason()).toBe("another process signed with this key")
        expect(logSpy).toHaveBeenCalledWith("[SIGNING] already stopped (another process signed with this key); exiting after: Block 8 may have committed: lost COMMIT reply")
        expect(logSpy.mock.calls.some(([message]) => String(message).includes("stopped until this process exits:"))).toBe(false)
        expect(gracefulShutdown).toHaveBeenCalledWith("committed_block_follow_up", 1)
        logSpy.mockRestore()
    })

    it("does not exit from the debug transaction check after a diverged round", async () => {
        debugAssertions = true
        const txsSpy = spyOn(Chain, "getTransactionsFromHashes").mockResolvedValue([
            { hash: "unmatched", blockNumber: getSharedState.lastBlockNumber + 1 } as any,
        ])
        roundError = () =>
            new BlockCommitUnknownError(8, new Error("connection lost during COMMIT"))

        try {
            await consensusRoutine()
            expect(exitSpy).not.toHaveBeenCalled()
            expect(getSharedState.runMainLoop).toBe(false)
        } finally {
            txsSpy.mockRestore()
            debugAssertions = false
        }
    }, 30000)
})
