/**
 * A proposal for a height we already committed is answered with that block
 * before any consensus-window or shard gate: right after our commit the
 * window for the next height is closed, and a plain refusal would send the
 * proposer into a retry that builds a second block.
 */

import { describe, expect, it, jest } from "bun:test"

const gates: string[] = []
const refusal = {
    result: 410,
    response: "self",
    require_reply: false,
    extra: {
        message: "Height already committed",
        committedBlock: { number: 6, hash: "x6" },
    },
}

const realCommitted = await import(
    "src/libs/consensus/v2/routines/committedBlock"
)
jest.mock("src/libs/consensus/v2/routines/committedBlock", () => ({
    ...realCommitted,
    committedHeightRefusal: async (height: unknown) =>
        height === 6 ? refusal : null,
}))
jest.mock("src/libs/consensus/routines/consensusTime", () => ({
    checkConsensusTime: async () => {
        gates.push("consensusTime")
        return false
    },
}))

const { default: manageConsensusRoutines } = await import(
    "./manageConsensusRoutines"
)

describe("proposeBlockHash for a committed height", () => {
    it("returns the committed block ahead of the consensus gates", async () => {
        gates.length = 0
        const res = await manageConsensusRoutines("peer", {
            method: "proposeBlockHash",
            params: ["y6", { signatures: {} }, "peer", 6],
        })
        expect(res).toEqual(refusal)
        expect(gates).toEqual([])
    })

    it("leaves an open height, or a proposal without one, to the usual path", async () => {
        gates.length = 0
        const open = await manageConsensusRoutines("peer", {
            method: "proposeBlockHash",
            params: ["y7", { signatures: {} }, "peer", 7],
        })
        const legacy = await manageConsensusRoutines("peer", {
            method: "proposeBlockHash",
            params: ["y6", { signatures: {} }, "peer"],
        })
        expect(open.result).toBe(400)
        expect(legacy.result).toBe(400)
        expect(gates).toEqual(["consensusTime", "consensusTime"])
    })
})
