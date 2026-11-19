/**
 * A proposal that reaches us while our own round is still forming the
 * candidate must wait for it, bounded, rather than be refused at once: the
 * proposer counts the refusal as a con vote and the round is lost.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"
import { mockCore } from "src/utilities/testSupport/coreMocks"

const sharedState: Record<string, unknown> = {
    candidateBlock: null,
    inConsensusLoop: false,
}
mockCore(sharedState)

const consensusRoutine = jest.fn(async () => {})
jest.mock("src/libs/consensus/v2/PoRBFT", () => ({ consensusRoutine }))
jest.mock("src/libs/consensus/routines/consensusTime", () => ({
    checkConsensusTime: async () => true,
}))

const { default: ensureCandidateBlockFormed } = await import(
    "./ensureCandidateBlockFormed"
)

beforeEach(() => {
    sharedState.candidateBlock = null
    sharedState.inConsensusLoop = false
    consensusRoutine.mockClear()
})

describe("while our round is running", () => {
    it("waits for the candidate it is forming", async () => {
        sharedState.inConsensusLoop = true
        setTimeout(() => {
            sharedState.candidateBlock = { number: 7 }
        }, 250)
        expect(await ensureCandidateBlockFormed(2000)).toBe(true)
        expect(consensusRoutine).not.toHaveBeenCalled()
    })

    it("gives up after the bound", async () => {
        sharedState.inConsensusLoop = true
        const start = Date.now()
        expect(await ensureCandidateBlockFormed(300)).toBe(false)
        const waited = Date.now() - start
        expect(waited).toBeGreaterThanOrEqual(250)
        expect(waited).toBeLessThan(1000)
    })

    it("stops waiting when the round ends without a candidate", async () => {
        sharedState.inConsensusLoop = true
        setTimeout(() => {
            sharedState.inConsensusLoop = false
        }, 150)
        const start = Date.now()
        expect(await ensureCandidateBlockFormed(2000)).toBe(false)
        expect(Date.now() - start).toBeLessThan(1000)
    })
})

describe("with a candidate already formed", () => {
    it("answers at once", async () => {
        sharedState.candidateBlock = { number: 7 }
        expect(await ensureCandidateBlockFormed(2000)).toBe(true)
    })
})
