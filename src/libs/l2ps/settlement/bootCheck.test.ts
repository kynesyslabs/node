import { afterEach, describe, expect, it } from "bun:test"
import { getSharedState } from "@/utilities/sharedState"
import { cloneDefaultForkConfig } from "@/forks/forkConfig"
import { settlementProverProblem, settlementScheduled, settlementVerifierProblem } from "./bootCheck"

const saved = getSharedState.forkConfig
afterEach(() => {
    getSharedState.forkConfig = saved
})

const schedule = (activationHeight: number | null) => {
    const config = cloneDefaultForkConfig()
    config.l2psSettlement.activationHeight = activationHeight
    getSharedState.forkConfig = config
}

const missingKey = () => {
    throw new Error("ENOENT: verification_key.json")
}

describe("settlement boot checks", () => {
    it("count the fork as scheduled at any height, ahead of activation too", () => {
        schedule(null)
        expect(settlementScheduled()).toBe(false)
        schedule(0)
        expect(settlementScheduled()).toBe(true)
        schedule(1_000_000)
        expect(settlementScheduled()).toBe(true)
    })

    it("refuse every node that cannot load the verification key once the fork is scheduled", () => {
        expect(settlementVerifierProblem(false, missingKey)).toBeNull()
        expect(settlementVerifierProblem(true, missingKey)).toContain("cannot verify settlement proofs: ENOENT")
        expect(settlementVerifierProblem(true, () => ({}))).toBeNull()
    })

    it("ask a subnet member, and only a member, for its proving files and a prover that starts", async () => {
        const ok = { scheduled: true, member: true, built: () => true, probe: async () => {} }
        expect(await settlementProverProblem(ok)).toBeNull()
        expect(await settlementProverProblem({ ...ok, built: () => false })).toContain("proving key or circuit is missing")
        const dead = { ...ok, probe: async () => Promise.reject(new Error("settlement prover 0 exited (code 2, signal null)")) }
        expect(await settlementProverProblem(dead)).toContain("prover does not start: settlement prover 0 exited")
        expect(await settlementProverProblem({ ...dead, built: () => false, member: false })).toBeNull()
        expect(await settlementProverProblem({ ...dead, scheduled: false })).toBeNull()
    })
})
