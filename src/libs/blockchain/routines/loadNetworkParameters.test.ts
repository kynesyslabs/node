/**
 * Fees are a consensus input once `feeBinding` checks them at apply, so the
 * parameters a node holds must come from its chain, never from a failed read.
 */

import { describe, expect, it } from "bun:test"

import { getSharedState } from "@/utilities/sharedState"
import {
    ensureNetworkParametersCurrent,
    loadNetworkParameters,
} from "./loadNetworkParameters"

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

    it("rereads after a failed read and loads the fee change it missed", async () => {
        await loadNetworkParameters(repoOf([feeUpgrade]))
        await loadNetworkParameters(failing)
        const raised = { ...feeUpgrade, proposalId: "p2", proposedParameters: { networkFee: 7 } }
        await ensureNetworkParametersCurrent(repoOf([feeUpgrade, raised]))
        expect(getSharedState.networkFee).toBe(7)
    })

    it("throws while the parameters still cannot be read", async () => {
        await loadNetworkParameters(repoOf([feeUpgrade]))
        await loadNetworkParameters(failing)
        await expect(ensureNetworkParametersCurrent(failing)).rejects.toThrow(
            "could not be read",
        )
        expect(getSharedState.networkFee).toBe(5)
    })

    it("does not reread after a successful read", async () => {
        await loadNetworkParameters(repoOf([feeUpgrade]))
        let reads = 0
        const counting = { find: async () => { reads++; return [] } } as never
        await ensureNetworkParametersCurrent(counting)
        expect(reads).toBe(0)
    })
})
