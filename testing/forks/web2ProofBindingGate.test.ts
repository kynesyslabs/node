import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { web2ProofBindingActiveForPendingBlock } from "@/forks/web2ProofBindingGate"
import { pendingTxSignatureContext } from "@/forks/signatureDomainGate"
import { cloneDefaultForkConfig, type ForkConfigByName } from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"

describe("web2ProofBinding gate", () => {
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
        expect(web2ProofBindingActiveForPendingBlock()).toBe(false)
    })

    it("judges a proof for the block it would land in: active from tip H-1", () => {
        getSharedState.forkConfig.web2ProofBinding.activationHeight = 100
        getSharedState.lastBlockNumber = 98
        expect(web2ProofBindingActiveForPendingBlock()).toBe(false)
        getSharedState.lastBlockNumber = 99
        expect(web2ProofBindingActiveForPendingBlock()).toBe(true)
        getSharedState.lastBlockNumber = 100
        expect(web2ProofBindingActiveForPendingBlock()).toBe(true)
    })

    it("flips at the same tip as signatureDomain scheduled at the same height", () => {
        getSharedState.forkConfig.web2ProofBinding.activationHeight = 100
        getSharedState.forkConfig.signatureDomain.activationHeight = 100
        for (const t of [97, 98, 99, 100, 101]) {
            getSharedState.lastBlockNumber = t
            expect(web2ProofBindingActiveForPendingBlock()).toBe(pendingTxSignatureContext().active)
        }
    })
})
