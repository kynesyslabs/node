/**
 * Under committeeBinding a round draws its bound committee once, from the
 * seed's own block, and hands that same list to getShard. A committee that
 * cannot be resolved aborts the round instead of reaching the routine's
 * fatal error path.
 */

import { beforeEach, describe, expect, jest, test } from "bun:test"

const OUR_KEY = "0x" + "aa".repeat(32)
const SECRETARY = "0x" + "11".repeat(32)
const MEMBER = "0x" + "22".repeat(32)

const sharedState: Record<string, any> = {
    lastBlockNumber: 101,
    lastBlockHash: "hash-101",
    publicKeyHex: OUR_KEY,
    shardSize: 4,
    forkConfig: { committeeBinding: { activationHeight: 0 } },
}

let committee: string[] | Error = []
const boundCalls: unknown[][] = []
const shardCalls: unknown[][] = []

jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warning: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        only: jest.fn(),
    },
}))
jest.mock("src/utilities/sharedState", () => ({
    __esModule: true,
    default: sharedState,
    getSharedState: sharedState,
}))
jest.mock("src/libs/peer", () => ({ Peer: class {}, PeerManager: { getInstance: () => ({}) } }))
jest.mock("src/libs/blockchain/chain", () => ({ __esModule: true, default: {} }))
jest.mock("../routines/getCommonValidatorSeed", () => ({
    __esModule: true,
    default: async () => ({ commonValidatorSeed: "seed", lastBlockNumber: 100 }),
}))

const member = (identity: string) => ({
    identity,
    connection: { string: `http://${identity.slice(2, 6)}` },
    sync: { block: 100, block_hash: "hash-100" },
})

const realGetShard = await import("../routines/getShard")
jest.mock("../routines/getShard", () => ({
    ...realGetShard,
    __esModule: true,
    default: async (...args: unknown[]) => {
        shardCalls.push(args)
        return [member(SECRETARY), member(OUR_KEY), member(MEMBER)]
    },
    getCommitteeFloor: () => 3,
    getBoundCommittee: async (...args: unknown[]) => {
        boundCalls.push(args)
        if (committee instanceof Error) throw committee
        return committee
    },
}))

const secretaryModule = await import("./secretaryManager")
const managers = secretaryModule.default
const abortError = secretaryModule.AbortConsensusError

beforeEach(() => {
    (managers as any).instances.clear()
    boundCalls.length = 0
    shardCalls.length = 0
    committee = [SECRETARY, OUR_KEY, MEMBER, "0x" + "33".repeat(32)]
    sharedState.lastBlockNumber = 101
    sharedState.lastBlockHash = "hash-101"
    sharedState.forkConfig.committeeBinding.activationHeight = 0
})

describe("SecretaryManager.initializeShard under committeeBinding", () => {
    test("draws the committee once from the seed's block and shares it with getShard", async () => {
        // The tip already moved to 101 while the round was set up for 100.
        sharedState.lastBlockNumber = 100
        sharedState.lastBlockHash = "hash-100"
        const manager = managers.getInstance(101, true)

        await manager.initializeShard("seed", 100)

        expect(boundCalls).toEqual([[100, "seed"]])
        expect(manager.boundCommittee).toEqual(committee as string[])
        expect(shardCalls).toEqual([["seed", 100, committee]])
        expect(manager.shard.secretaryKey).toBe(SECRETARY)
    })

    test("aborts the round when the committee cannot be resolved", async () => {
        committee = new Error("block 100 not found")
        const manager = managers.getInstance(101, true)

        const failure = await manager.initializeShard("seed", 100).catch(e => e)

        expect(failure).toBeInstanceOf(abortError)
        expect(failure.message).toContain("block 100 not found")
        expect(shardCalls).toHaveLength(0)
    })

    test("draws no bound committee before the fork", async () => {
        sharedState.forkConfig.committeeBinding.activationHeight = null
        sharedState.lastBlockNumber = 100
        sharedState.lastBlockHash = "hash-100"
        const manager = managers.getInstance(101, true)

        await manager.initializeShard("seed", 100)

        expect(boundCalls).toHaveLength(0)
        expect(manager.boundCommittee).toBeNull()
        expect(shardCalls).toEqual([["seed", 100, undefined]])
    })
})
