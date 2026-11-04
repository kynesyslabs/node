/**
 * The producer's pre-commit check under committeeBinding, with real ed25519
 * signatures verified through a started TxValidatorPool. A producer must
 * commit exactly the blocks that syncing nodes accept, so the check is
 * compared with verifyBlock on every signer subset of a small pool.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from "bun:test"
import {
    type Signer,
    type StubChain,
    makeBlock,
    makeSigner,
    mockCommitteeChain,
    signedBy,
} from "../../../../../testing/consensus/committeeTestKit"

const sharedState: Record<string, any> = {
    signingAlgorithm: "ed25519",
    shardSize: 4,
    publicKeyHex: "",
    lastBlockNumber: 9,
    lastBlockHash: "hash-9",
    forkConfig: {
        quorumParity: { activationHeight: 0 },
        committeeBinding: { activationHeight: 0 },
    },
    identity: { masterSeed: new Uint8Array(128).fill(7) },
    getBlockTimestampMinDelta: () => 1,
    getBlockTimestampTolerance: () => 60,
}

const chain: StubChain = { peerlist: [], staked: null, tip: 9 }
mockCommitteeChain(sharedState, chain)

jest.mock("src/libs/utils/calibrateTime", () => ({
    getNetworkTimestamp: () => 2000,
}))
jest.mock("src/libs/debug/nonceTrace", () => ({
    debugAssertionsEnabled: () => false,
}))
jest.mock("src/libs/blockchain/validation/verifyBlockTxSignatures", () => ({
    verifyBlockTxSignatures: async () => ({ valid: true }),
}))

const { verifyBlock } = await import("src/libs/blockchain/validation/verifyBlock")
const { committeeCommitShortfall, producerCommitRefusal } = await import("./committeeCommit")
const { getBoundCommittee, __resetValidatorCache: resetPoolCache } = await import("./getShard")
const validatorPool = (
    await import("src/libs/blockchain/validation/txValidatorPool")
).default.getInstance()

let signers: Signer[] = []
let committee: string[] = []
let committeeSigners: Signer[] = []
let outsiders: Signer[] = []

beforeAll(async () => {
    signers = await Promise.all(Array.from({ length: 6 }, (_, i) => makeSigner(`commit-test-${i}`, i + 1)))
    await validatorPool.start(1)
})

afterAll(async () => {
    await validatorPool.stop()
})

beforeEach(async () => {
    resetPoolCache()
    chain.peerlist = signers.map(s => s.identity)
    committee = await getBoundCommittee(9)
    committeeSigners = committee.map(id => signers.find(s => s.identity === id))
    outsiders = signers.filter(s => !committee.includes(s.identity))
})

describe("committeeCommitShortfall", () => {
    it("allows a commit carrying a quorum of committee signatures", async () => {
        const block = await signedBy(makeBlock("a"), committeeSigners.slice(0, 3))
        expect(await committeeCommitShortfall(block, committee, 4)).toBeNull()
    })

    it("refuses a commit whose pro votes came from outside the committee", async () => {
        const block = await signedBy(makeBlock("a"), [...committeeSigners.slice(0, 2), ...outsiders])
        expect(await committeeCommitShortfall(block, committee, 4)).toBe(
            "block 10 carries 2 verified signatures of its bound committee of 4, below the 3 sync requires",
        )
    })

    it("does not count a committee signature over another hash", async () => {
        const block = await signedBy(makeBlock("a"), committeeSigners.slice(0, 2))
        block.validation_data.signatures[committeeSigners[2].identity] =
            await committeeSigners[2].sign(makeBlock("b").hash)
        expect(await committeeCommitShortfall(block, committee, 4)).toContain("carries 2 verified")
    })

    it("refuses a block without validation data", async () => {
        const block = makeBlock("a")
        delete block.validation_data
        expect(await committeeCommitShortfall(block, committee, 4)).toContain("carries 0 verified")
    })

    it("agrees with verifyBlock on every subset of signers", async () => {
        for (let mask = 0; mask < 1 << signers.length; mask++) {
            const subset = signers.filter((_, i) => mask & (1 << i))
            const block = await signedBy(makeBlock(`m${mask}`), subset)
            const commits = (await committeeCommitShortfall(block, committee, 4)) === null
            const accepted = (await verifyBlock(block)).valid
            expect({ mask, commits }).toEqual({ mask, commits: accepted })
        }
    })
})

describe("producerCommitRefusal", () => {
    it("lets the vote tally decide before the fork, without checking signatures", async () => {
        expect(await producerCommitRefusal(makeBlock("a"), null, 4)).toBeNull()
    })

    it("returns the abort reason when the committee signatures fall short", async () => {
        const block = await signedBy(makeBlock("a"), [...committeeSigners.slice(0, 2), ...outsiders])
        expect(await producerCommitRefusal(block, committee, 4)).toBe(
            "Not committing: block 10 carries 2 verified signatures of its bound committee of 4, below the 3 sync requires",
        )
    })

    it("lets the commit proceed with a quorum of committee signatures", async () => {
        const block = await signedBy(makeBlock("a"), committeeSigners.slice(0, 3))
        expect(await producerCommitRefusal(block, committee, 4)).toBeNull()
    })
})
