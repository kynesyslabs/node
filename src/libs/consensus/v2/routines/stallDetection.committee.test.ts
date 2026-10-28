/**
 * Under committeeBinding stall detection asks whether we were in the bound
 * committee of a synced block, which is exact, instead of reconstructing the
 * draw from the block's committed peerlist.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"

const OUR_KEY = "0x" + "ab".repeat(32)
const OTHER = "0x" + "cd".repeat(32)

const sharedState: Record<string, any> = {
    publicKeyHex: OUR_KEY,
    shardSize: 4,
    fastSyncCount: 1,
    consecutiveMissedShardBlocks: 0,
    forkConfig: { committeeBinding: { activationHeight: 0 } },
    getConsensusTime: () => 10,
}
let committee: string[] = []
let missedCount = 0

jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warning: jest.fn(), error: jest.fn() },
}))
jest.mock("src/utilities/sharedState", () => ({
    __esModule: true,
    default: sharedState,
    getSharedState: sharedState,
}))
jest.mock("src/config", () => ({
    Config: { getInstance: () => ({ core: { stallDetectionBlocks: 0 } }) },
}))
jest.mock("src/libs/debug/nonceTrace", () => ({ debugAssertionsEnabled: () => false }))
jest.mock("src/libs/utils/calibrateTime", () => ({ getNetworkTimestamp: () => 1010 }))
jest.mock("src/libs/consensus/routines/consensusTime", () => ({
    SECRETARY_ROTATION_GRACE_SECONDS: 90,
}))
jest.mock("src/libs/blockchain/block", () => ({ __esModule: true, default: class {} }))
jest.mock("src/libs/peer", () => ({
    Peer: class {
        identity: string
        constructor(_url: string, identity: string) {
            this.identity = identity
        }
    },
}))
jest.mock("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getBlockByNumber: async (n: number) => ({ number: n, hash: `hash-${n}` }) },
}))
jest.mock("./getCommonValidatorSeed", () => ({
    __esModule: true,
    default: async () => ({ commonValidatorSeed: "seed" }),
}))
jest.mock("./getShard", () => ({
    getEligiblePool: async () => [OUR_KEY, OTHER],
    getBoundCommittee: async () => committee,
    pinShardIdentities: () => "",
}))
jest.mock("@/features/metrics/consensusMetrics", () => ({
    countMissedSignature: () => {
        missedCount++
    },
}))

const { recordSyncedBlock } = await import("./stallDetection")

const syncedBlock = (peerlist: string[]) =>
    ({
        number: 10,
        validation_data: { signatures: {} },
        content: { timestamp: 1000, peerlist },
    }) as never

beforeEach(() => {
    missedCount = 0
    sharedState.consecutiveMissedShardBlocks = 0
    sharedState.forkConfig.committeeBinding.activationHeight = 0
})

describe("stall detection under committeeBinding", () => {
    it("counts a miss when we sat on the bound committee, even outside the committed peerlist", async () => {
        committee = [OUR_KEY, OTHER]
        await recordSyncedBlock(syncedBlock([OTHER]))
        expect(missedCount).toBe(1)
        expect(sharedState.consecutiveMissedShardBlocks).toBe(1)
    })

    it("counts no miss when we were not on the bound committee", async () => {
        committee = [OTHER]
        await recordSyncedBlock(syncedBlock([OUR_KEY, OTHER]))
        expect(missedCount).toBe(0)
    })

    it("reconstructs the draw from the committed peerlist before the fork", async () => {
        sharedState.forkConfig.committeeBinding.activationHeight = null
        committee = [OUR_KEY, OTHER]
        await recordSyncedBlock(syncedBlock([OTHER]))
        expect(missedCount).toBe(0)

        await recordSyncedBlock(syncedBlock([OUR_KEY, OTHER]))
        expect(missedCount).toBe(1)
    })
})
