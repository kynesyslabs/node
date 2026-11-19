/**
 * The stall detector must reconstruct the committee getShard draws. It drew
 * over the live candidates while getShard ranks the whole pool and then
 * keeps the live members, so with a live view smaller than the pool the two
 * disagreed: alarms for keys getShard never drew and silence for keys it did.
 *
 * Real getShard, real recordSyncedBlock: 12 eligible validators, 8 of them
 * live, and the synced block commits exactly those 8, so the detector's
 * stand-in for the forger's view equals getShard's view.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test"

const V = (n: number) => n.toString(16).padStart(2, "0").repeat(32)
const SELF = V(1)
const POOL = Array.from({ length: 12 }, (_, i) => V(i + 1))
const LIVE = POOL.filter((_, i) => i % 3 !== 2)
const HEIGHT = 100

let seed = "seed"
let missed = 0

const sharedState: Record<string, any> = {
    publicKeyHex: SELF,
    lastBlockNumber: HEIGHT,
    lastBlockHash: "tiphash",
    shardSize: 4,
    fastSyncCount: 1,
    consecutiveMissedShardBlocks: 0,
    forkScheduleDifferingPeers: new Set(),
    getConsensusTime: () => 10,
}

const silent = { debug() {}, info() {}, warning() {}, warn() {}, error() {}, only() {}, custom() {} }
mock.module("src/utilities/logger", () => ({ __esModule: true, default: silent }))
mock.module("src/utilities/sharedState", () => ({ __esModule: true, default: sharedState, getSharedState: sharedState }))
mock.module("src/config", () => ({ Config: { getInstance: () => ({ core: { stallDetectionBlocks: 0 } }) } }))
mock.module("src/libs/debug/nonceTrace", () => ({ debugAssertionsEnabled: () => false }))
mock.module("src/libs/utils/calibrateTime", () => ({ getNetworkTimestamp: () => 1010 }))
mock.module("src/libs/consensus/routines/consensusTime", () => ({ SECRETARY_ROTATION_GRACE_SECONDS: 90 }))
mock.module("@/forks/forkGates", () => ({ isForkActive: () => false }))
mock.module("@/features/metrics/consensusMetrics", () => ({ countMissedSignature: () => void missed++ }))
mock.module("./getCommonValidatorSeed", () => ({ __esModule: true, default: async () => ({ commonValidatorSeed: seed }) }))

class FakePeer {
    connection: { string: string }
    identity: string
    sync?: { block: number }
    constructor(url = "", identity = "") {
        this.connection = { string: url }
        this.identity = identity
    }
}
const online = LIVE.filter(id => id !== SELF).map(id => Object.assign(new FakePeer(`http://${id.slice(0, 6)}`, id), { sync: { block: HEIGHT } }))
class FakePeerManager {
    static getInstance() {
        return new FakePeerManager()
    }
    async getOnlinePeers() {
        return online
    }
    getPeers() {
        return online
    }
    getPeer(identity: string) {
        return online.find(p => p.identity === identity)
    }
}
mock.module("src/libs/peer/PeerManager", () => ({ __esModule: true, default: FakePeerManager }))
mock.module("src/libs/peer", () => ({ Peer: FakePeer, PeerManager: FakePeerManager }))
mock.module("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getBlockByNumber: async (n: number) => ({ number: n, hash: `hash-${n}`, content: { peerlist: POOL, timestamp: 1000 } }) },
}))
mock.module("src/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: { getGCRValidatorsAtBlock: async () => POOL.map(address => ({ address, connection_url: null })) },
}))

const { default: getShard, __resetValidatorCache } = await import("./getShard")
const { recordSyncedBlock } = await import("./stallDetection")

const syncedBlock = () =>
    ({ number: HEIGHT + 1, validation_data: { signatures: {} }, content: { timestamp: 1000, peerlist: LIVE } }) as never

beforeEach(() => {
    __resetValidatorCache()
    missed = 0
    sharedState.consecutiveMissedShardBlocks = 0
})

describe("stall detection reconstructs getShard's committee", () => {
    it("alarms exactly for the seeds whose getShard committee holds this node", async () => {
        const disagreements: string[] = []
        let drawn = 0
        for (let i = 0; i < 60; i++) {
            seed = `seed-${i}`
            __resetValidatorCache()
            const inShard = (await getShard(seed, HEIGHT)).some(p => p.identity === SELF)
            missed = 0
            await recordSyncedBlock(syncedBlock())
            if (inShard) drawn++
            if (inShard !== (missed === 1)) disagreements.push(`${seed}: getShard=${inShard} detector=${missed === 1}`)
        }
        // Both outcomes occur, so agreement is not a constant answer.
        expect(drawn).toBeGreaterThan(0)
        expect(drawn).toBeLessThan(60)
        expect(disagreements).toEqual([])
    })
})
