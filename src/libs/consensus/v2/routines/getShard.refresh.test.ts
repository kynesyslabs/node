import { getSharedState } from "src/utilities/sharedState"
import { __resetValidatorCache, getBoundPool, getEligiblePool } from "./getShard"
import {
    POOL_REFRESH_DEPTH,
    POOL_REFRESH_INTERVAL,
    isPoolRefreshHeight,
    poolRefreshHeights,
    refreshedPeerlist,
} from "./poolRules"

const V = (n: number) => n.toString(16).padStart(2, "0").repeat(32)
const HONEST = [V(1), V(2), V(3), V(4), V(5), V(6), V(7), V(8)]
const COALITION = [V(11), V(12), V(13), V(14), V(15), V(16), V(17)]
const STAKED = [...HONEST, ...COALITION, V(20)] // V(20) staked but never seen online

const E = POOL_REFRESH_INTERVAL
const REFRESH = 4 * E // a refresh block whose window holds three earlier refresh blocks, not genesis

// Peerlists by block height; any other stored block commits the coalition only.
let peerlists: Map<number, string[]>
let missing: Set<number>

jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: Object.fromEntries(
        ["debug", "info", "warning", "error", "only", "custom"].map(level => [level, jest.fn()]),
    ),
}))

jest.mock("src/utilities/sharedState", () => ({
    getSharedState: {
        publicKeyHex: "aa".repeat(32),
        lastBlockNumber: 100,
        lastBlockHash: "tiphash",
        shardSize: 10,
        forkConfig: { peerlistFloor: { activationHeight: null }, finalityProofs: { activationHeight: null } },
    },
}))

jest.mock("src/libs/peer/PeerManager", () => ({
    __esModule: true,
    default: { getInstance: () => ({ getPeers: () => [], getOnlinePeers: async () => [] }) },
}))

jest.mock("src/libs/peer", () => ({
    Peer: class {},
    PeerManager: jest.requireMock("src/libs/peer/PeerManager").default,
}))

jest.mock("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: {
        getBlockByNumber: jest.fn(async (n: number) =>
            missing.has(n)
                ? null
                : { number: n, hash: `hash-${n}`, content: { peerlist: peerlists.get(n) ?? [...COALITION] } },
        ),
    },
}))

jest.mock("src/libs/blockchain/finality/validatorSet", () => ({
    validatorSetAt: jest.fn(async () => ({ validators: [] })),
    activeIdentities: () => new Set(STAKED),
}))

jest.mock("src/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: {
        getGCRValidatorsAtBlock: jest.fn(async () => STAKED.map(address => ({ address }))),
    },
}))

const sorted = (ids: string[]) => [...ids].sort()

beforeEach(() => {
    __resetValidatorCache()
    getSharedState.forkConfig.peerlistFloor.activationHeight = null
    getSharedState.forkConfig.finalityProofs.activationHeight = null
    missing = new Set()
    // The refresh blocks before the capture saw every online validator.
    peerlists = new Map([
        [E, [...HONEST, ...COALITION]],
        [2 * E, [...HONEST, ...COALITION]],
    ])
})

describe("pool refresh heights", () => {
    it("are the positive multiples of the interval", () => {
        expect(isPoolRefreshHeight(0)).toBe(false)
        expect(isPoolRefreshHeight(E - 1)).toBe(false)
        expect(isPoolRefreshHeight(E)).toBe(true)
        expect(isPoolRefreshHeight(5 * E)).toBe(true)
    })

    it("sample the previous refresh blocks, newest first, and the genesis set (0) while the window reaches it", () => {
        expect(poolRefreshHeights(E)).toEqual([0])
        expect(poolRefreshHeights(3 * E)).toEqual([2 * E, E, 0])
        expect(poolRefreshHeights(4 * E)).toEqual([3 * E, 2 * E, E])
        const deep = (POOL_REFRESH_DEPTH + 3) * E
        expect(poolRefreshHeights(deep)).toHaveLength(POOL_REFRESH_DEPTH)
        expect(poolRefreshHeights(deep)[0]).toBe(deep - E)
    })

    it("keep an empty parent list empty, so the bootstrap rule still applies", () => {
        expect(refreshedPeerlist([], [[V(1)]])).toEqual([])
        expect(refreshedPeerlist([V(2)], [[V(1), V(2)], [V(3)]])).toEqual(sorted([V(1), V(2), V(3)]))
    })
})

describe("a captured chain: every block since the last refresh commits the coalition only", () => {
    it("before peerlistFloor, the next committee is drawn from the coalition alone", async () => {
        expect(await getEligiblePool(REFRESH - 1)).toEqual(sorted(COALITION))
        expect(await getBoundPool(REFRESH - 1)).toEqual(sorted(COALITION))
    })

    it("under peerlistFloor, the refresh block draws from the honest set again", async () => {
        getSharedState.forkConfig.peerlistFloor.activationHeight = 0
        expect(await getBoundPool(REFRESH - 1)).toEqual(sorted([...HONEST, ...COALITION]))
    })

    it("leaves out a staked validator no sampled committee saw", async () => {
        getSharedState.forkConfig.peerlistFloor.activationHeight = 0
        expect(await getEligiblePool(REFRESH - 1)).not.toContain(V(20))
    })

    it("does not widen the pool between refresh heights", async () => {
        getSharedState.forkConfig.peerlistFloor.activationHeight = 0
        expect(await getEligiblePool(REFRESH - 2)).toEqual(sorted(COALITION))
        expect(await getEligiblePool(REFRESH)).toEqual(sorted(COALITION))
    })

    it("applies from the activation height of the block drawn", async () => {
        getSharedState.forkConfig.peerlistFloor.activationHeight = REFRESH + 1
        expect(await getEligiblePool(REFRESH - 1)).toEqual(sorted(COALITION))
        __resetValidatorCache()
        getSharedState.forkConfig.peerlistFloor.activationHeight = REFRESH
        expect(await getEligiblePool(REFRESH - 1)).toEqual(sorted([...HONEST, ...COALITION]))
    })

    it("a capture before the first refresh: the first refresh draws from the recorded genesis set", async () => {
        getSharedState.forkConfig.peerlistFloor.activationHeight = 0
        getSharedState.forkConfig.finalityProofs.activationHeight = 0
        peerlists = new Map()
        expect(await getBoundPool(E - 1)).toEqual(sorted(STAKED))
        expect(await getEligiblePool(2 * E - 1)).toEqual(sorted(STAKED))
    })

    it("does not sample the genesis set where it was not recorded (finalityProofs after block 1)", async () => {
        getSharedState.forkConfig.peerlistFloor.activationHeight = 0
        getSharedState.forkConfig.finalityProofs.activationHeight = 2
        peerlists = new Map()
        expect(await getBoundPool(E - 1)).toEqual(sorted(COALITION))
    })

    it("refuses to draw when a sampled block is missing instead of reading it as empty", async () => {
        getSharedState.forkConfig.peerlistFloor.activationHeight = 0
        missing.add(E)
        await expect(getEligiblePool(REFRESH - 1)).rejects.toThrow(`block ${E} is missing`)
    })
})
