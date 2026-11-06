/**
 * Fees are a consensus input once `feeBinding` checks them at apply, so the
 * parameters a node holds must come from its chain, never from a failed read.
 */

import { describe, expect, it } from "bun:test"

import { getSharedState } from "@/utilities/sharedState"
import { loadNetworkParameters } from "./loadNetworkParameters"

const repoOf = (rows: unknown[]) => ({ find: async () => rows }) as never
const failing = { find: async () => { throw new Error("connection lost") } } as never

const feeUpgrade = {
    proposalId: "p1",
    status: "active",
    effectiveAtBlock: 10,
    proposedParameters: { networkFee: 5, rpcFee: 4 },
}

describe("loadNetworkParameters", () => {
    it("folds active upgrades onto the genesis values", async () => {
        const params = await loadNetworkParameters(repoOf([feeUpgrade]))
        expect(params.networkFee).toBe(5)
        expect(getSharedState.networkFee).toBe(5)
        expect(getSharedState.rpcFee).toBe(4)
    })

    it("keeps the loaded parameters when a later read fails", async () => {
        await loadNetworkParameters(repoOf([feeUpgrade]))
        const params = await loadNetworkParameters(failing)
        expect(params.networkFee).toBe(5)
        expect(getSharedState.networkFee).toBe(5)
        expect(getSharedState.rpcFee).toBe(4)
    })
})
