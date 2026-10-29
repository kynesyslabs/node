/**
 * A round that finds too few of its bound committee live asks the members it
 * could not count for the block: a member that already certified it looks
 * the same as one that is down to a node that missed the push. Any other
 * ending of the round asks nobody.
 */

import { afterAll, afterEach, describe, expect, it, mock, spyOn } from "bun:test"

type ShardState = {
    boundCommittee: string[] | null
    members: string[]
    // the height the round's shard is for, relative to our next height
    blockRefOffset?: number
}
let shardState: ShardState = { boundCommittee: null, members: [] }
let shardError: () => Error = () => new Error("unset")
const probed: Array<[number, string[], string[]]> = []

const realSync = await import("@/libs/blockchain/routines/Sync")
const realCommitted = await import("./routines/committedBlock")
const errors = await import("@/errors")

mock.module("@/libs/blockchain/routines/Sync", () => ({
    ...realSync,
    fastSync: async () => ({ latestChainBlock: 7, ourLatestBlock: 7 }),
    waitForPeerStatus: async () => true,
    unreconciledGcrBlockNumber: () => null,
    assertNoUnreconciledGcrState: async () => undefined,
}))
mock.module("./routines/committedBlock", () => ({
    ...realCommitted,
    adoptBeforeRetry: async () => false,
    recordFailedRound: () => undefined,
    probeCommitteeForHeight: (height: number, committee: string[], live: any[]) => {
        probed.push([height, committee, live.map(p => p.identity)])
    },
}))
mock.module("./routines/getCommonValidatorSeed", () => ({
    __esModule: true,
    default: async () => {
        // What initializeShard leaves on the round before it throws
        const height = getSharedState.lastBlockNumber + 1
        const manager = SecretaryManager.getInstance(height)
        manager.boundCommittee = shardState.boundCommittee
        manager.shard = {
            ...manager.shard,
            blockRef: height + (shardState.blockRefOffset ?? 0),
            members: shardState.members.map(identity => ({ identity })) as any,
        }
        throw shardError()
    },
}))

const { getSharedState } = await import("src/utilities/sharedState")
const { default: SecretaryManager } = await import("./types/secretaryManager")
const { consensusRoutine } = await import("./PoRBFT")

const exitSpy = spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called")
}) as never)
afterAll(() => exitSpy.mockRestore())

getSharedState.setShardSizeFromGenesis(4) // floor of 3

afterEach(() => {
    probed.length = 0
    shardState = { boundCommittee: null, members: [] }
    getSharedState.syncStatus = true
    getSharedState.fastSyncCount = 0
    getSharedState.inConsensusLoop = false
})

const belowFloor = () =>
    new errors.NotInShardError("Committee below minimum size: refusing to forge")

describe("probing the bound committee after a short round", () => {
    it("asks the members it could not count when the bound committee is below the floor", async () => {
        shardState = { boundCommittee: ["self", "a", "b", "c"], members: ["self"] }
        shardError = belowFloor
        const height = getSharedState.lastBlockNumber + 1
        await consensusRoutine()
        expect(probed).toEqual([[height, ["self", "a", "b", "c"], ["self"]]])
    }, 30000)

    it("asks nobody without a bound committee", async () => {
        shardState = { boundCommittee: null, members: ["self"] }
        shardError = belowFloor
        await consensusRoutine()
        expect(probed).toEqual([])
    }, 30000)

    it("asks nobody when enough members are live and we are just not among them", async () => {
        shardState = { boundCommittee: ["a", "b", "c", "d"], members: ["a", "b", "c"] }
        shardError = () => new errors.NotInShardError("We are not in the shard")
        await consensusRoutine()
        expect(probed).toEqual([])
    }, 30000)

    it("asks nobody when the round ended another way", async () => {
        shardState = { boundCommittee: ["self", "a", "b", "c"], members: ["self"] }
        shardError = () => new errors.ForgingEndedError("stop here")
        await consensusRoutine()
        expect(probed).toEqual([])
    }, 30000)

    it("asks nobody when the short shard is for another height than the round", async () => {
        shardState = {
            boundCommittee: ["self", "a", "b", "c"],
            members: ["self"],
            blockRefOffset: 1,
        }
        shardError = belowFloor
        await consensusRoutine()
        expect(probed).toEqual([])
    }, 30000)
})
