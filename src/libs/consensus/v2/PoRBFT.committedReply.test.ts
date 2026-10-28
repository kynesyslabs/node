/**
 * Members that answer a proposal with a block they already committed end the
 * round on that block when one of them serves it with a verified quorum.
 * When none does, or taking it fails outright, the round's own tally
 * decides: a peer that served a header and then dropped must neither end the
 * process nor leave the round thinking the height is filled.
 */

import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"

let adoptImpl: (height: number, peers: any[], context: string) => Promise<boolean>
const adoptCalls: Array<[number, string[], string]> = []

let latchedDrift: number | null = null

const realSync = await import("@/libs/blockchain/routines/Sync")
mock.module("@/libs/blockchain/routines/Sync", () => ({
    ...realSync,
    unreconciledGcrBlockNumber: () => latchedDrift,
}))

const realCommitted = await import("./routines/committedBlock")
mock.module("./routines/committedBlock", () => ({
    ...realCommitted,
    adoptBlockFromPeers: async (height: number, peers: any[], context: string) => {
        adoptCalls.push([height, peers.map(p => p.identity), context])
        return adoptImpl(height, peers, context)
    },
}))

const { adoptReportedCommit } = await import("./PoRBFT")
const { AbortConsensusError } = await import("./types/secretaryManager")
const { getSharedState } = await import("src/utilities/sharedState")

const report = (identity: string, hash = "x6") => ({
    peer: { identity } as any,
    hash,
})

const exitSpy = spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called")
}) as never)

afterAll(() => exitSpy.mockRestore())

beforeEach(() => {
    adoptCalls.length = 0
    adoptImpl = async () => true
    latchedDrift = null
    getSharedState.syncStatus = true
    exitSpy.mockClear()
})

describe("a proposal answered with a committed block", () => {
    it("ends the round on the member's block once it is adopted", async () => {
        expect(await adoptReportedCommit(6, [report("a"), report("b")])).toBe(true)
        expect(adoptCalls).toEqual([[6, ["a", "b"], "proposeBlockHash"]])
    })

    it("leaves the decision to our own tally when no member serves a block that verifies", async () => {
        adoptImpl = async () => false
        expect(await adoptReportedCommit(6, [report("a")])).toBe(false)
        expect(adoptCalls).toHaveLength(1)
    })

    it("treats a failure while taking the block as not having it, without exiting", async () => {
        adoptImpl = async () => {
            throw new Error("transactions missing from a")
        }
        expect(await adoptReportedCommit(6, [report("a")])).toBe(false)
        expect(exitSpy).not.toHaveBeenCalled()
    })

    it("aborts the round instead of falling back to its tally when the failed block's undo also failed", async () => {
        adoptImpl = async () => {
            // syncBlock latches the drift when it cannot undo a failed apply
            latchedDrift = 6
            throw new Error("rollback of block 6 failed")
        }
        await expect(adoptReportedCommit(6, [report("a")])).rejects.toBeInstanceOf(
            AbortConsensusError,
        )
        expect(getSharedState.syncStatus).toBe(false)
        expect(exitSpy).not.toHaveBeenCalled()
    })

    it("asks nobody when no member reported a commit", async () => {
        expect(await adoptReportedCommit(6, [])).toBe(false)
        expect(adoptCalls).toEqual([])
    })
})
