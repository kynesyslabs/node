/**
 * proposeBlockHash acts for the authenticated sender: the peer id in the
 * params names nobody and the sender must be in the round committee. The
 * signature map it relays is judged like verifyBlock judges signatures:
 * limited to the eligible pool and bounded by min(shardSize, pool).
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"

const OUR_KEY = "0x" + "aa".repeat(32)
const MEMBER_A = "0x" + "a1".repeat(32)
const MEMBER_B = "0x" + "b2".repeat(32)
const OUTSIDER = "0x" + "ee".repeat(32)
// In the eligible pool but not in this node's own round committee.
const POOL_ONLY = "0x" + "c3".repeat(32)
const CANDIDATE_HASH = "cand-hash"

const candidate = {
    hash: CANDIDATE_HASH,
    number: 101,
    content: { timestamp: 1000, ordered_transactions: [] as string[] },
    validation_data: { signatures: {} as Record<string, string> },
}
const sharedState: Record<string, unknown> = {
    publicKeyHex: OUR_KEY,
    signingAlgorithm: "ed25519",
    candidateBlock: candidate,
    shardSize: 4,
}
let pool = [OUR_KEY, MEMBER_A, MEMBER_B, POOL_ONLY]
const shard = [OUR_KEY, MEMBER_A, MEMBER_B].map(identity => ({
    identity,
    connection: { string: "http://" + identity.slice(2, 6) },
}))
const verified: string[] = []

jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        only: jest.fn(),
        custom: jest.fn(),
    },
}))
jest.mock("src/utilities/sharedState", () => ({
    __esModule: true,
    default: sharedState,
    getSharedState: sharedState,
}))
jest.mock("src/utilities/waiter", () => ({ Waiter: { keys: {} } }))
jest.mock("src/libs/network/server_rpc", () => ({
    emptyResponse: { result: 0, response: "", require_reply: false, extra: null },
}))
jest.mock("src/libs/consensus/routines/consensusTime", () => ({
    checkConsensusTime: async () => true,
}))
jest.mock("src/libs/consensus/v2/routines/networkAheadVeto", () => ({
    isNetworkAhead: async () => false,
}))
jest.mock("src/libs/consensus/v2/routines/roundCommittee", () => ({
    __esModule: true,
    default: async () => ({ members: shard, seed: "seed", frozen: true }),
}))
jest.mock("src/libs/consensus/v2/routines/getShard", () => ({
    getEligiblePool: async () => pool,
}))
jest.mock("src/libs/consensus/v2/routines/getCommonValidatorSeed", () => ({
    __esModule: true,
    default: async () => ({ commonValidatorSeed: "seed" }),
}))
jest.mock("src/libs/consensus/v2/routines/ensureCandidateBlockFormed", () => ({
    __esModule: true,
    default: async () => true,
}))
jest.mock("src/libs/consensus/v2/PoRBFT", () => ({
    consensusRoutine: async () => undefined,
    isConsensusAlreadyRunning: () => true,
}))
jest.mock("src/libs/consensus/v2/types/secretaryManager", () => ({
    __esModule: true,
    default: { getInstance: () => undefined },
}))
jest.mock("src/libs/blockchain/routines/Sync", () => ({
    fastSync: async () => undefined,
}))
jest.mock("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getBlockByNumber: async () => ({ content: { timestamp: 900 } }) },
}))
jest.mock("src/libs/blockchain/validation/verifyBlock", () => ({
    checkTimestampAgainstParent: () => ({ valid: true }),
}))
jest.mock("src/libs/blockchain/validation/txValidatorPool", () => ({
    __esModule: true,
    default: {
        getInstance: () => ({
            verify: async ({ publicKey }: { publicKey: Uint8Array }) => {
                verified.push(Buffer.from(publicKey).toString("hex"))
                return true
            },
        }),
    },
}))
jest.mock("src/libs/peer", () => ({
    PeerManager: { getInstance: () => ({ getPeer: () => undefined }) },
}))
jest.mock("src/libs/peer/PeerManager", () => ({
    __esModule: true,
    default: { getInstance: () => ({ getPeer: () => undefined }) },
}))

const { default: manageConsensusRoutines } = await import("./manageConsensusRoutines")

const sig = "ab".repeat(64)
const propose = (sender: string, proposer: string, signatures: Record<string, string>) =>
    manageConsensusRoutines(sender, {
        method: "proposeBlockHash",
        params: [CANDIDATE_HASH, { signatures }, proposer],
    })

beforeEach(() => {
    candidate.validation_data.signatures = {}
    verified.length = 0
    pool = [OUR_KEY, MEMBER_A, MEMBER_B, POOL_ONLY]
    sharedState.shardSize = 4
})

describe("proposeBlockHash sender", () => {
    it("refuses a non-member that names a member as the proposer", async () => {
        const res = await propose(OUTSIDER, MEMBER_A, {})

        expect(res.result).toBe(401)
        expect(res.extra).toBe("Validator is not in the shard")
        expect(candidate.validation_data.signatures).toEqual({})
    })

    it("accepts a member under its own authenticated identity, whatever the params say", async () => {
        const res = await propose(MEMBER_A, OUTSIDER, {})

        expect(res.result).toBe(200)
    })

    it("drops a signature from outside the eligible pool and merges the pool's own", async () => {
        const res = await propose(MEMBER_A, MEMBER_A, {
            [OUTSIDER]: sig,
            [MEMBER_B]: sig,
        })

        expect(res.result).toBe(200)
        expect(candidate.validation_data.signatures).toEqual({ [MEMBER_B]: sig })
        expect(verified).toEqual([MEMBER_B.slice(2)])
    })

    it("keeps a pool signer that is not in our own committee view", async () => {
        const res = await propose(MEMBER_A, MEMBER_A, { [POOL_ONLY]: sig })

        expect(res.result).toBe(200)
        expect(candidate.validation_data.signatures).toEqual({ [POOL_ONLY]: sig })
    })

    it("accepts a map as large as min(shardSize, pool), even when our committee is smaller", async () => {
        const res = await propose(MEMBER_A, MEMBER_A, {
            [OUR_KEY]: sig,
            [MEMBER_A]: sig,
            [MEMBER_B]: sig,
            [POOL_ONLY]: sig,
        })

        expect(res.result).toBe(200)
        expect(Object.keys(candidate.validation_data.signatures)).toHaveLength(4)
    })

    it("refuses a map larger than min(shardSize, pool)", async () => {
        const padded: Record<string, string> = {}
        for (let i = 0; i < 5; i++) {
            padded["0x" + String(i).padStart(2, "0").repeat(32)] = sig
        }

        const res = await propose(MEMBER_A, MEMBER_A, padded)

        expect(res.result).toBe(400)
        expect(verified).toHaveLength(0)
        expect(candidate.validation_data.signatures).toEqual({})
    })

    it("caps by the pool when the pool is smaller than the shard size", async () => {
        pool = [MEMBER_A, MEMBER_B]
        sharedState.shardSize = 10

        const res = await propose(MEMBER_A, MEMBER_A, {
            [MEMBER_A]: sig,
            [MEMBER_B]: sig,
            [OUR_KEY]: sig,
        })

        expect(res.result).toBe(400)
    })

    it("treats a missing signature map as empty", async () => {
        const res = await manageConsensusRoutines(MEMBER_A, {
            method: "proposeBlockHash",
            params: [CANDIDATE_HASH, {}, MEMBER_A],
        })

        expect(res.result).toBe(200)
    })
})
