/**
 * Under `l2psSettlement` the entry node's local L2PS proof path is off: no
 * proof row is written and none is applied at consensus, since only the
 * entry node held them and so only it moved the balances (DEM-816).
 */
import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test"

mock.module("@/utilities/logger", () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() },
}))

import { cloneDefaultForkConfig } from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"

const { default: L2PSProofManager } = await import("./L2PSProofManager")
const { default: L2PSConsensus } = await import("./L2PSConsensus")

const saved = { forkConfig: getSharedState.forkConfig, lastBlockNumber: getSharedState.lastBlockNumber }
const original = {
    getRepo: (L2PSProofManager as any).getRepo,
    getProofsForBlock: L2PSProofManager.getProofsForBlock,
}
let repoReads = 0
let proofReads = 0

beforeEach(() => {
    getSharedState.forkConfig = cloneDefaultForkConfig()
    getSharedState.lastBlockNumber = 100
    repoReads = 0
    proofReads = 0
    ;(L2PSProofManager as any).getRepo = async () => {
        repoReads++
        throw new Error("no database in this test")
    }
    ;(L2PSProofManager as any).getProofsForBlock = async () => {
        proofReads++
        return []
    }
})

afterEach(() => {
    Object.assign(getSharedState, saved)
    ;(L2PSProofManager as any).getRepo = original.getRepo
    ;(L2PSProofManager as any).getProofsForBlock = original.getProofsForBlock
})

describe("the local L2PS proof path", () => {
    it("writes no proof row under the fork", async () => {
        getSharedState.forkConfig.l2psSettlement.activationHeight = 0
        const out = await L2PSProofManager.createProof("subnet", "batch", [], 0, 1, ["h"])
        expect(out.success).toBe(false)
        expect(out.message).toContain("l2psSettlement")
        expect(repoReads).toBe(0)
    })

    it("applies no proof at consensus under the fork", async () => {
        getSharedState.forkConfig.l2psSettlement.activationHeight = 0
        const out = await L2PSConsensus.applyPendingProofs(101, false)
        expect(out.proofsApplied).toBe(0)
        expect(proofReads).toBe(0)
    })

    it("still reads pending proofs before the fork", async () => {
        await L2PSConsensus.applyPendingProofs(101, false)
        expect(proofReads).toBe(1)
        await L2PSProofManager.createProof("subnet", "batch", [], 0, 1, ["h"])
        expect(repoReads).toBe(1)
    })
})
