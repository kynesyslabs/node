import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test"
import { verifyWeb2Proof } from "@/libs/abstraction"
import { GithubProofParser } from "@/libs/abstraction/web2/github"
import TxValidatorPool from "@/libs/blockchain/validation/txValidatorPool"
import { cloneDefaultForkConfig, type ForkConfigByName } from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"

const SENDER = "ab".repeat(32)
const LEGACY_MESSAGE = "dw2p"
const payload: any = {
    context: "github",
    username: "someone",
    proof: "https://gist.github.com/someone/abc",
}

// The pool is replaced by one that accepts only the legacy-shaped message, so
// the result says whether verifyWeb2Proof reached the legacy fallback at all.
describe("verifyWeb2Proof uses the web2ProofBinding gate", () => {
    let forks: ForkConfigByName
    let tip: number
    let chainId: number | null
    const restores: Array<() => void> = []

    beforeEach(() => {
        forks = getSharedState.forkConfig
        tip = getSharedState.lastBlockNumber
        chainId = getSharedState.chainId
        getSharedState.forkConfig = cloneDefaultForkConfig()
        getSharedState.chainId = 1

        const parser = spyOn(GithubProofParser, "getInstance").mockResolvedValue({
            readData: async () => ({
                message: LEGACY_MESSAGE,
                type: "ed25519",
                signature: "00",
            }),
        } as any)
        const pool = spyOn(TxValidatorPool, "getInstance").mockReturnValue({
            verify: async ({ message }: { message: Uint8Array }) =>
                new TextDecoder().decode(message) === LEGACY_MESSAGE,
        } as any)
        restores.push(() => parser.mockRestore(), () => pool.mockRestore())
    })
    afterEach(() => {
        while (restores.length) restores.pop()!()
        getSharedState.forkConfig = forks
        getSharedState.lastBlockNumber = tip
        getSharedState.chainId = chainId
    })

    it("accepts the legacy shape while the fork is unscheduled", async () => {
        getSharedState.lastBlockNumber = 1_000_000
        expect((await verifyWeb2Proof(payload, SENDER)).success).toBe(true)
    })

    it("accepts the legacy shape up to tip H-2 and refuses it from tip H-1", async () => {
        getSharedState.forkConfig.web2ProofBinding.activationHeight = 100
        getSharedState.lastBlockNumber = 98
        expect((await verifyWeb2Proof(payload, SENDER)).success).toBe(true)
        getSharedState.lastBlockNumber = 99
        expect((await verifyWeb2Proof(payload, SENDER)).success).toBe(false)
    })
})
