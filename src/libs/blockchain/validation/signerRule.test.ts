/**
 * The signer rule sync applies to a block, which getFinalizedHead also hands
 * to clients: the bound committee and 2/3 + 1 of shardSize under
 * committeeBinding, the eligible pool and the pool-relative bar before it
 * (shardSize again under quorumParity). Under canonicalSigners a member
 * listed in two cases is one lowercase member and sizes the pool once.
 */

import { beforeEach, describe, expect, it, jest, mock } from "bun:test"

const sharedState: Record<string, any> = {
    shardSize: 4,
    forkConfig: {
        committeeBinding: { activationHeight: null },
        quorumParity: { activationHeight: null },
        canonicalSigners: { activationHeight: null },
    },
}
const getBoundCommittee = jest.fn(async (_parent: number) => ["a", "b", "c", "d"])
const getEligiblePool = jest.fn(async (_parent: number) => ["a", "b"])

mock.module("src/utilities/sharedState", () => ({ __esModule: true, getSharedState: sharedState }))
mock.module("@/utilities/sharedState", () => ({ __esModule: true, getSharedState: sharedState }))
mock.module("src/libs/consensus/v2/routines/getShard", () => ({
    __esModule: true,
    getBoundCommittee,
    getEligiblePool,
}))

const { signerRuleOf } = await import("./signerRule")

beforeEach(() => {
    getBoundCommittee.mockClear()
    getEligiblePool.mockClear()
    sharedState.forkConfig.committeeBinding.activationHeight = null
    sharedState.forkConfig.quorumParity.activationHeight = null
    sharedState.forkConfig.canonicalSigners.activationHeight = null
})

describe("signerRuleOf", () => {
    it("is the eligible pool at the parent with the pool-relative bar before the forks", async () => {
        expect(await signerRuleOf(10)).toEqual({ bound: false, members: ["a", "b"], threshold: 2 })
        expect(getEligiblePool).toHaveBeenCalledWith(9)
        expect(getBoundCommittee).not.toHaveBeenCalled()
    })

    it("pins the bar to shardSize under quorumParity", async () => {
        sharedState.forkConfig.quorumParity.activationHeight = 10
        expect((await signerRuleOf(10)).threshold).toBe(3)
        expect((await signerRuleOf(9)).threshold).toBe(2)
    })

    it("is the set in lowercase, each once, under canonicalSigners", async () => {
        // getFinalizedHead hands these members to clients as `committee`: in
        // the pool's own spelling a client would match fewer stored keys.
        sharedState.forkConfig.canonicalSigners.activationHeight = 10
        getEligiblePool.mockResolvedValueOnce(["a", "B", "A", "b"])
        expect(await signerRuleOf(10)).toEqual({ bound: false, members: ["a", "b"], threshold: 2 })
        sharedState.forkConfig.committeeBinding.activationHeight = 10
        getBoundCommittee.mockResolvedValueOnce(["C", "a", "c", "D", "b"])
        expect(await signerRuleOf(10)).toEqual({ bound: true, members: ["c", "a", "d", "b"], threshold: 3 })
    })

    it("is the set as listed while canonicalSigners is dormant", async () => {
        const listed = ["a", "B", "A", "b"]
        sharedState.forkConfig.canonicalSigners.activationHeight = 10
        getEligiblePool.mockResolvedValueOnce(listed).mockResolvedValueOnce(listed)
        const before = await signerRuleOf(9)
        expect(before).toEqual({ bound: false, members: ["a", "B", "A", "b"], threshold: 3 })
        expect(before.members).toBe(listed)
        sharedState.forkConfig.canonicalSigners.activationHeight = null
        expect((await signerRuleOf(10)).members).toBe(listed)
    })

    it("is the committee bound at the parent under committeeBinding", async () => {
        sharedState.forkConfig.committeeBinding.activationHeight = 10
        expect(await signerRuleOf(10)).toEqual({ bound: true, members: ["a", "b", "c", "d"], threshold: 3 })
        expect(getBoundCommittee).toHaveBeenCalledWith(9)
    })

    it("throws when the set cannot be read", async () => {
        getEligiblePool.mockRejectedValueOnce(new Error("block 9 not found"))
        await expect(signerRuleOf(10)).rejects.toThrow("block 9 not found")
    })
})
