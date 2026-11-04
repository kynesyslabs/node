/**
 * The commit lock exchange is answered outside the consensus window and
 * never starts a round: a late precommit request or a retry's lock query
 * reaches its handler, and a precommit request for a height we committed is
 * answered with that block.
 */

import { describe, expect, it, jest } from "bun:test"

const gates: string[] = []
const handled: { method: string; sender: string; params: unknown[] }[] = []
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
jest.mock("src/libs/consensus/v2/commitLock/precommit", () => ({
    managePrecommitBlockHash: async (sender: string, params: unknown[]) => {
        handled.push({ method: "precommitBlockHash", sender, params })
        return { result: 200, response: "self", require_reply: false, extra: null }
    },
}))
jest.mock("src/libs/consensus/v2/commitLock/getLock", () => ({
    manageGetLock: async (sender: string, params: unknown[]) => {
        handled.push({ method: "getLock", sender, params })
        return { result: 200, response: "self", require_reply: false, extra: { lock: null } }
    },
}))

const { default: manageConsensusRoutines } = await import(
    "./manageConsensusRoutines"
)

describe("commit lock methods", () => {
    it("hand a precommit request to its handler outside the consensus window", async () => {
        gates.length = 0
        handled.length = 0
        const params = ["x7", 5000, 7, {}, {}]
        const res = await manageConsensusRoutines("peer", {
            method: "precommitBlockHash",
            params,
        })
        expect(res.result).toBe(200)
        expect(handled).toEqual([{ method: "precommitBlockHash", sender: "peer", params }])
        expect(gates).toEqual([])
    })

    it("answer a precommit request for a committed height with the block", async () => {
        handled.length = 0
        const res = await manageConsensusRoutines("peer", {
            method: "precommitBlockHash",
            params: ["y6", 5000, 6, {}, {}],
        })
        expect(res).toEqual(refusal)
        expect(handled).toEqual([])
    })

    it("hand a lock query to its handler outside the consensus window", async () => {
        gates.length = 0
        handled.length = 0
        const res = await manageConsensusRoutines("peer", {
            method: "getLock",
            params: [7],
        })
        expect(res.result).toBe(200)
        expect(handled).toEqual([{ method: "getLock", sender: "peer", params: [7] }])
        expect(gates).toEqual([])
    })
})
