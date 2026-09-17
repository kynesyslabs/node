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
    currentTxSignatureContext,
    txSignaturePreimageForTip,
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

describe("the node's own signing preimage", () => {
    it("follows the chain tip across activation", () => {
        sharedState.forkConfig.signatureDomain = { activationHeight: 10 }
        sharedState.chainId = 3

        sharedState.lastBlockNumber = 9
        expect(new TextDecoder().decode(txSignaturePreimageForTip(HASH))).toBe(
            HASH,
        )

        sharedState.lastBlockNumber = 10
        expect(new TextDecoder().decode(txSignaturePreimageForTip(HASH))).toBe(
            `${TX_SIGNATURE_DOMAIN}3:${HASH}`,
        )
        expect(currentTxSignatureContext().active).toBe(true)
    })
})
