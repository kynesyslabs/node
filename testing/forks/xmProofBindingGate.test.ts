import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { xmProofBindingActiveForPendingBlock } from "@/forks/xmProofBindingGate"
import { cloneDefaultForkConfig, type ForkConfigByName } from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"

describe("xmProofBinding gate", () => {
    let forks: ForkConfigByName
    let tip: number
    let chainId: number | null

    beforeEach(() => {
        forks = getSharedState.forkConfig
        tip = getSharedState.lastBlockNumber
        chainId = getSharedState.chainId
        getSharedState.forkConfig = cloneDefaultForkConfig()
        getSharedState.chainId = 1
    })
    afterEach(() => {
        getSharedState.forkConfig = forks
        getSharedState.lastBlockNumber = tip
        getSharedState.chainId = chainId
    })

    it("is inactive when the fork is unscheduled", () => {
        getSharedState.lastBlockNumber = 1_000_000
        expect(xmProofBindingActiveForPendingBlock()).toBe(false)
    })

    it("judges an xm proof for the block it would land in: active from tip H-1", () => {
        getSharedState.forkConfig.xmProofBinding.activationHeight = 100
        getSharedState.lastBlockNumber = 98
        expect(xmProofBindingActiveForPendingBlock()).toBe(false)
        getSharedState.lastBlockNumber = 99
        expect(xmProofBindingActiveForPendingBlock()).toBe(true)
        getSharedState.lastBlockNumber = 100
        expect(xmProofBindingActiveForPendingBlock()).toBe(true)
    })
})
