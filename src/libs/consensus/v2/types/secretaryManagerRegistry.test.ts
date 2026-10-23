import { beforeEach, describe, expect, jest, test } from "bun:test"

const sharedState = { lastBlockNumber: 100, lastBlockHash: "h", publicKeyHex: "aa".repeat(32) }

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
jest.mock("src/utilities/sharedState", () => ({ getSharedState: sharedState }))
jest.mock("src/libs/peer", () => ({ Peer: class {}, PeerManager: { getInstance: () => ({}) } }))
jest.mock("src/libs/blockchain/chain", () => ({ __esModule: true, default: {} }))
jest.mock("../routines/getShard", () => ({
    __esModule: true,
    default: async () => [],
    getCommitteeFloor: () => 1,
}))
jest.mock("../routines/getCommonValidatorSeed", () => ({
    __esModule: true,
    default: async () => ({ commonValidatorSeed: "seed", lastBlockNumber: 100 }),
}))

import SecretaryManager from "./secretaryManager"

const knownBlocks = () =>
    Array.from((SecretaryManager as any).instances.keys() as Iterable<number>).sort((a, b) => a - b)

beforeEach(() => {
    (SecretaryManager as any).instances.clear()
    sharedState.lastBlockNumber = 100
})

describe("SecretaryManager registry", () => {
    test("a round that ends before drawing its shard is dropped", async () => {
        const manager = SecretaryManager.getInstance(101, true)
        expect(manager.shard).toBeUndefined()
        expect(knownBlocks()).toEqual([101])

        await manager.endConsensusRoutine()

        expect(knownBlocks()).toEqual([])
    })

    test("starting a round prunes rounds for blocks already in the chain", () => {
        SecretaryManager.getInstance(95, true)
        SecretaryManager.getInstance(98, true)
        sharedState.lastBlockNumber = 100
        SecretaryManager.getInstance(101, true)
        expect(knownBlocks()).toEqual([101])

        sharedState.lastBlockNumber = 101
        SecretaryManager.getInstance(102, true)
        expect(knownBlocks()).toEqual([102])
    })

    test("lookups without initialize never add entries", () => {
        expect(SecretaryManager.getInstance(500)).toBeNull()
        expect(knownBlocks()).toEqual([])
    })
})
