import { expect, it, jest, mock } from "bun:test"
const state = { runMainLoop: false, candidateBlock: null as object | null }
const consensusRoutine = jest.fn(async () => {})
const checkConsensusTime = jest.fn(async () => true)
mock.module("src/utilities/sharedState", () => ({ getSharedState: state }))
mock.module("../PoRBFT", () => ({ consensusRoutine }))
mock.module("src/libs/consensus/routines/consensusTime", () => ({ checkConsensusTime }))
mock.module("src/utilities/logger", () => ({ default: { info: jest.fn(), warning: jest.fn() } }))
const { default: ensureCandidateBlockFormed } = await import("./ensureCandidateBlockFormed")
it("answers for an existing candidate but never starts a round during shutdown", async () => {
    state.candidateBlock = {}
    expect(await ensureCandidateBlockFormed()).toBe(true)
    state.candidateBlock = null
    expect(await ensureCandidateBlockFormed()).toBe(false)
    expect(consensusRoutine).not.toHaveBeenCalled()
    expect(checkConsensusTime).not.toHaveBeenCalled()
})
