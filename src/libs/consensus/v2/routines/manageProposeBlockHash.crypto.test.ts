/**
 * The proposeBlockHash handler merges relayed signatures only after real
 * ed25519 verification against our candidate's hash, and under
 * committeeBinding only from members of the bound committee. The committee
 * is drawn by the real getShard code from a stubbed chain.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from "bun:test"
import {
    type Signer,
    type StubChain,
    makeSigner,
    mockCommitteeChain,
} from "../../../../../testing/consensus/committeeTestKit"

const sharedState: Record<string, any> = {
    signingAlgorithm: "ed25519",
    shardSize: 4,
    publicKeyHex: "",
    lastBlockNumber: 100,
    lastBlockHash: "hash-100",
    candidateBlock: null,
    forkConfig: { committeeBinding: { activationHeight: 0 } },
    identity: { masterSeed: new Uint8Array(128).fill(42) },
}

const chain: StubChain = { peerlist: [], staked: null, tip: 100 }
mockCommitteeChain(sharedState, chain)

let roundMembers: { identity: string; connection: { string: string } }[] = []

jest.mock("src/libs/network/server_rpc", () => ({
    emptyResponse: { result: 0, response: "", require_reply: false, extra: null },
}))
jest.mock("src/libs/consensus/v2/routines/networkAheadVeto", () => ({
    isNetworkAhead: async () => false,
}))
jest.mock("src/libs/consensus/v2/routines/roundCommittee", () => ({
    __esModule: true,
    default: async () => ({ members: roundMembers, seed: "unused", frozen: true }),
}))
jest.mock("src/libs/consensus/v2/routines/ensureCandidateBlockFormed", () => ({
    __esModule: true,
    default: async () => true,
}))
jest.mock("src/libs/blockchain/validation/verifyBlock", () => ({
    checkTimestampAgainstParent: () => ({ valid: true }),
}))

const { default: manageProposeBlockHash } = await import("./manageProposeBlockHash")
const { getBoundCommittee, __resetValidatorCache: resetPoolCache } = await import("./getShard")
const validatorPool = (await import("src/libs/blockchain/validation/txValidatorPool")).default.getInstance()

const CANDIDATE_HASH = "c0ffee".repeat(10)
const OTHER_HASH = "beef".repeat(16)

let signers: Signer[] = []
let members: Signer[] = []
let outsider: Signer
let proposer: Signer

const flipLastByte = (sig: string) => sig.slice(0, -2) + (sig.slice(-2) === "00" ? "01" : "00")
const merged = () => Object.keys(sharedState.candidateBlock.validation_data.signatures).sort()

beforeAll(async () => {
    signers = await Promise.all(Array.from({ length: 6 }, (_, i) => makeSigner(`handler-test-${i}`, i + 101)))
    await validatorPool.start(1)
})

afterAll(async () => {
    await validatorPool.stop()
})

beforeEach(async () => {
    resetPoolCache()
    sharedState.forkConfig.committeeBinding.activationHeight = 0
    chain.peerlist = signers.map(s => s.identity)
    const committee = await getBoundCommittee(100)
    members = committee.map(id => signers.find(s => s.identity === id))
    outsider = signers.find(s => !committee.includes(s.identity))
    proposer = members[0]
    sharedState.publicKeyHex = members[1].identity
    roundMembers = signers.map(s => ({ identity: s.identity, connection: { string: "http://x" } }))
    sharedState.candidateBlock = {
        hash: CANDIDATE_HASH,
        number: 101,
        content: { timestamp: 2000, ordered_transactions: [] },
        validation_data: { signatures: {} },
    }
})

describe("proposeBlockHash with real ed25519 signatures", () => {
    it("merges a committee member's valid signature", async () => {
        const res = await manageProposeBlockHash(
            CANDIDATE_HASH,
            { signatures: { [proposer.identity]: await proposer.sign(CANDIDATE_HASH) } } as any,
            proposer.identity,
        )

        expect(res.result).toBe(200)
        expect(merged()).toEqual([proposer.identity])
    })

    it("drops a forged signature and keeps the genuine ones", async () => {
        const res = await manageProposeBlockHash(
            CANDIDATE_HASH,
            {
                signatures: {
                    [proposer.identity]: await proposer.sign(CANDIDATE_HASH),
                    [members[2].identity]: flipLastByte(await members[2].sign(CANDIDATE_HASH)),
                    [members[3].identity]: await members[3].sign(OTHER_HASH),
                },
            } as any,
            proposer.identity,
        )

        expect(res.result).toBe(200)
        expect(merged()).toEqual([proposer.identity])
    })

    it("drops a valid signature by a pool member outside the bound committee", async () => {
        const res = await manageProposeBlockHash(
            CANDIDATE_HASH,
            {
                signatures: {
                    [proposer.identity]: await proposer.sign(CANDIDATE_HASH),
                    [outsider.identity]: await outsider.sign(CANDIDATE_HASH),
                },
            } as any,
            proposer.identity,
        )

        expect(res.result).toBe(200)
        expect(merged()).toEqual([proposer.identity])
    })

    it("refuses a proposer outside the bound committee even with a valid signature", async () => {
        const res = await manageProposeBlockHash(
            CANDIDATE_HASH,
            { signatures: { [outsider.identity]: await outsider.sign(CANDIDATE_HASH) } } as any,
            outsider.identity,
        )

        expect(res.result).toBe(401)
        expect(merged()).toEqual([])
    })

    it("keeps the outside pool member's signature before the fork", async () => {
        sharedState.forkConfig.committeeBinding.activationHeight = null
        const res = await manageProposeBlockHash(
            CANDIDATE_HASH,
            {
                signatures: {
                    [proposer.identity]: await proposer.sign(CANDIDATE_HASH),
                    [outsider.identity]: await outsider.sign(CANDIDATE_HASH),
                },
            } as any,
            proposer.identity,
        )

        expect(res.result).toBe(200)
        expect(merged()).toEqual([proposer.identity, outsider.identity].sort())
    })
})
