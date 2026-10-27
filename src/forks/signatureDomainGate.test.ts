const sharedState: {
    forkConfig: Record<string, { activationHeight: number | null }>
    lastBlockNumber: number
    chainId: number | null
} = {
    forkConfig: { signatureDomain: { activationHeight: null } },
    lastBlockNumber: 0,
    chainId: 1,
}

jest.mock("@/utilities/sharedState", () => ({
    getSharedState: sharedState,
}))

import {
    txSignatureContext,
    pendingTxSignatureContext,
    txSignaturePreimageForPendingBlock,
} from "./signatureDomainGate"
import { TX_SIGNATURE_DOMAIN } from "@/libs/crypto/txSignaturePreimage"

const HASH = "4d".repeat(32)

beforeEach(() => {
    sharedState.forkConfig.signatureDomain = { activationHeight: null }
    sharedState.lastBlockNumber = 0
    sharedState.chainId = 1
})

describe("txSignatureContext", () => {
    it("is inactive when the fork is unscheduled", () => {
        expect(txSignatureContext(1_000_000)).toEqual({
            active: false,
            chainId: 0,
        })
    })

    it("is inactive below the activation height", () => {
        sharedState.forkConfig.signatureDomain = { activationHeight: 100 }

        expect(txSignatureContext(99).active).toBe(false)
    })

    it("carries the chain id from the activation height on", () => {
        sharedState.forkConfig.signatureDomain = { activationHeight: 100 }
        sharedState.chainId = 7

        expect(txSignatureContext(100)).toEqual({ active: true, chainId: 7 })
    })

    it("refuses to bind signatures when genesis declared no chain id", () => {
        // Falling back to a default would let a signature made here verify on
        // another chain that chose the same default, which is the replay this
        // fork exists to stop.
        sharedState.forkConfig.signatureDomain = { activationHeight: 0 }
        sharedState.chainId = null

        expect(() => txSignatureContext(0)).toThrow(/no properties.id/)
    })
})

describe("txSignatureContext for a sealed block", () => {
    it("follows the block's own height, whatever the tip is", () => {
        // Replaying history: the tip is far ahead of the block being judged,
        // and the verdict must be the one the network reached at that height.
        sharedState.forkConfig.signatureDomain = { activationHeight: 100 }
        sharedState.chainId = 1337
        sharedState.lastBlockNumber = 10_000

        expect(txSignatureContext(99)).toEqual({ active: false, chainId: 0 })
        expect(txSignatureContext(100)).toEqual({ active: true, chainId: 1337 })
        expect(txSignatureContext(101)).toEqual({ active: true, chainId: 1337 })
        // While the pending-block context at that tip is already domain-bound.
        expect(pendingTxSignatureContext().active).toBe(true)
    })

    it("binds from genesis when the fork is scheduled at 0", () => {
        sharedState.forkConfig.signatureDomain = { activationHeight: 0 }
        sharedState.chainId = 1337

        expect(txSignatureContext(0)).toEqual({ active: true, chainId: 1337 })
        expect(txSignatureContext(1)).toEqual({ active: true, chainId: 1337 })
    })

    it("hands back the chain id of this network, not a default", () => {
        sharedState.forkConfig.signatureDomain = { activationHeight: 0 }

        sharedState.chainId = 1
        const onMainnetLike = txSignatureContext(5)
        sharedState.chainId = 1337
        const onDevnetLike = txSignatureContext(5)

        expect(onMainnetLike.chainId).toBe(1)
        expect(onDevnetLike.chainId).toBe(1337)
    })
})

describe("the node's own signing preimage", () => {
    it("switches one block before the tip reaches activation", () => {
        // A transaction signed while the chain sits at H-1 is included in
        // block H, so it has to satisfy the rule at H. Following the tip
        // instead would sign the legacy bare hash for the activation block
        // itself, and the validators applying the new rule would reject it.
        sharedState.forkConfig.signatureDomain = { activationHeight: 10 }
        sharedState.chainId = 3

        sharedState.lastBlockNumber = 8
        expect(
            new TextDecoder().decode(txSignaturePreimageForPendingBlock(HASH)),
        ).toBe(HASH)

        sharedState.lastBlockNumber = 9
        expect(
            new TextDecoder().decode(txSignaturePreimageForPendingBlock(HASH)),
        ).toBe(`${TX_SIGNATURE_DOMAIN}3:${HASH}`)
        expect(pendingTxSignatureContext().active).toBe(true)
    })

    it("stays domain-bound once the fork is behind the tip", () => {
        sharedState.forkConfig.signatureDomain = { activationHeight: 10 }
        sharedState.chainId = 3
        sharedState.lastBlockNumber = 500

        expect(pendingTxSignatureContext()).toEqual({
            active: true,
            chainId: 3,
        })
    })
})
