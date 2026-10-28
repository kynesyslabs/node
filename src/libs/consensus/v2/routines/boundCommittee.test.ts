/**
 * Under committeeBinding the committee for block h is chain data: the bound
 * pool at h - 1 ranked with the parent's common validator seed, pins first,
 * capped at shardSize. Who is online only decides which members the local
 * node talks to, never who the members are.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"
import { PINNED_SHARD_IDENTITIES } from "src/utilities/constants"

const V = (n: number) => "0x" + n.toString(16).padStart(2, "0").repeat(32)
const SELF = V(1)

interface FakePeerShape {
    identity: string
    connection: { string: string }
    sync?: { block: number; block_hash: string }
}

let committedPeerlist: string[] = []
// Per-height peerlists; heights not listed commit `committedPeerlist`.
let peerlistAt: Record<number, string[]> = {}
let validatorAddresses: string[] = []
let onlinePeers: FakePeerShape[] = []

const sharedState: Record<string, any> = {
    publicKeyHex: SELF,
    lastBlockNumber: 100,
    lastBlockHash: "hash-100",
    shardSize: 4,
    forkConfig: { committeeBinding: { activationHeight: 0 } },
}

jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
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

class FakePeerManager {
    static getInstance() {
        return new FakePeerManager()
    }
    async getOnlinePeers() {
        return onlinePeers
    }
    getPeers() {
        return onlinePeers
    }
    getPeer(identity: string) {
        return onlinePeers.find(p => p.identity === identity)
    }
}

class FakePeer {
    connection: { string: string }
    identity: string
    constructor(url = "", publicKey = "") {
        this.connection = { string: url }
        this.identity = publicKey
    }
}

jest.mock("src/libs/peer/PeerManager", () => ({
    __esModule: true,
    default: FakePeerManager,
}))
jest.mock("src/libs/peer", () => ({
    Peer: FakePeer,
    PeerManager: FakePeerManager,
}))

const block = (n: number) => ({
    number: n,
    hash: `hash-${n}`,
    content: { peerlist: peerlistAt[n] ?? committedPeerlist, timestamp: 1000 + n },
})

jest.mock("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: {
        getBlockByNumber: jest.fn(async (n: number) => (n >= 0 ? block(n) : null)),
        getLastBlock: jest.fn(async () => block(sharedState.lastBlockNumber)),
        getGenesisBlockHash: jest.fn(async () => "hash-0"),
    },
}))

jest.mock("src/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: {
        getGCRValidatorsAtBlock: jest.fn(async () =>
            validatorAddresses.map(address => ({ address })),
        ),
    },
}))

const {
    default: getShard,
    __resetValidatorCache: resetPoolCache,
    drawBoundCommittee,
    getBoundCommittee,
    getBoundPool,
    getEligiblePool,
    pinRankedPool,
    rankPool,
} = await import("./getShard")
const { default: getCommonValidatorSeed } = await import("./getCommonValidatorSeed")

const onlinePeer = (identity: string, height = 100): FakePeerShape => ({
    identity,
    connection: { string: `http://${identity.slice(2, 8)}` },
    sync: { block: height, block_hash: `hash-${height}` },
})
const ids = (peers: { identity: string }[]) => peers.map(p => p.identity)

beforeEach(() => {
    resetPoolCache()
    sharedState.shardSize = 4
    sharedState.forkConfig = { committeeBinding: { activationHeight: 0 } }
    sharedState.lastBlockNumber = 100
    sharedState.lastBlockHash = "hash-100"
    peerlistAt = {}
    committedPeerlist = [V(1), V(2), V(3), V(4), V(5), V(6), V(7), V(8)]
    validatorAddresses = [...committedPeerlist]
    onlinePeers = committedPeerlist.slice(1).map(id => onlinePeer(id))
})

describe("pinRankedPool", () => {
    const [PIN_A, PIN_B, PIN_C] = PINNED_SHARD_IDENTITIES

    it("leaves a ranking without pins untouched", () => {
        const ranked = [V(3), V(1), V(2)]
        expect(pinRankedPool(ranked)).toEqual(ranked)
    })

    it("moves the pins present to the front in pin order", () => {
        const ranked = [V(3), PIN_C, V(1), PIN_A, V(2)]
        expect(pinRankedPool(ranked)).toEqual([PIN_A, PIN_C, V(3), V(1), V(2)])
    })

    it("skips pins that are not in the pool", () => {
        expect(pinRankedPool([V(2), PIN_B])).toEqual([PIN_B, V(2)])
    })
})

describe("drawBoundCommittee", () => {
    const pool = Array.from({ length: 14 }, (_, i) => V(i + 1))

    it("is the first shardSize entries of the ranked pool", () => {
        expect(drawBoundCommittee("seed", pool, 10)).toEqual(
            rankPool("seed", pool).slice(0, 10),
        )
    })

    it("is deterministic for a seed and changes with it", () => {
        expect(drawBoundCommittee("s", pool, 10)).toEqual(drawBoundCommittee("s", pool, 10))
        expect(drawBoundCommittee("s", pool, 10)).not.toEqual(drawBoundCommittee("t", pool, 10))
    })

    it("is the whole pool when the pool is smaller than shardSize", () => {
        expect([...drawBoundCommittee("seed", pool.slice(0, 3), 10)].sort()).toEqual(
            pool.slice(0, 3),
        )
    })

    it("seats every pinned pool member, online or not", () => {
        const withPins = [...pool, ...PINNED_SHARD_IDENTITIES]
        const committee = drawBoundCommittee("seed", withPins, 4)
        expect(committee.slice(0, 3)).toEqual([...PINNED_SHARD_IDENTITIES])
        expect(committee).toHaveLength(4)
    })
})

describe("getBoundPool", () => {
    it("is the eligible pool when it holds a quorum", async () => {
        expect(await getBoundPool(100)).toEqual(await getEligiblePool(100))
    })

    it("falls back to every staked validator when the pool is below the quorum", async () => {
        committedPeerlist = [V(1), V(2)]
        validatorAddresses = [V(9), V(1), V(2), V(8), V(7)]
        expect(await getEligiblePool(100)).toEqual([V(1), V(2)])
        expect(await getBoundPool(100)).toEqual([V(1), V(2), V(7), V(8), V(9)])
    })

    it("keeps the pool when the staked set is no larger", async () => {
        committedPeerlist = [V(1), V(2)]
        validatorAddresses = [V(1), V(2)]
        expect(await getBoundPool(100)).toEqual([V(1), V(2)])
    })
})

describe("a chain that defines no pool", () => {
    beforeEach(() => {
        committedPeerlist = []
        validatorAddresses = []
    })

    it("still answers getEligiblePool from the local peer view before the fork", async () => {
        expect(await getEligiblePool(100)).toContain(SELF)
    })

    it("draws no bound committee from the local peer view", async () => {
        expect(await getEligiblePool(100)).not.toHaveLength(0)
        expect(await getBoundPool(100)).toEqual([])
        expect(await getBoundCommittee(100, "seed")).toEqual([])
        expect(await getShard("seed", 100)).toEqual([])
    })
})

describe("getBoundCommittee", () => {
    it("derives the seed from the stored parent the way a producer at that tip does", async () => {
        // The tip and an older parent commit different peerlists, so a
        // committee drawn from the wrong height or seed would differ.
        peerlistAt[105] = [V(2), V(4), V(6), V(8), V(9), V(10), V(11)]
        validatorAddresses = [...committedPeerlist, V(9), V(10), V(11)]
        sharedState.lastBlockNumber = 105
        sharedState.lastBlockHash = "hash-105"

        const tip = await getCommonValidatorSeed()
        expect(tip.lastBlockNumber).toBe(105)
        const producerCommittee = await getBoundCommittee(105, tip.commonValidatorSeed)
        expect(await getBoundCommittee(105)).toEqual(producerCommittee)
        expect(producerCommittee.every(id => peerlistAt[105].includes(id))).toBe(true)

        const { commonValidatorSeed: parentSeed } = await getCommonValidatorSeed(
            block(100) as any,
        )
        expect(parentSeed).not.toBe(tip.commonValidatorSeed)
        const olderCommittee = await getBoundCommittee(100)
        expect(olderCommittee).toEqual(await getBoundCommittee(100, parentSeed))
        expect(olderCommittee.every(id => committedPeerlist.includes(id))).toBe(true)
        expect(olderCommittee).not.toEqual(producerCommittee)
    })

    it("depends only on chain data, not on who is online", async () => {
        const before = await getBoundCommittee(100)
        onlinePeers = []
        expect(await getBoundCommittee(100)).toEqual(before)
    })

    it("refuses a parent that is not stored", async () => {
        await expect(getBoundCommittee(-1)).rejects.toThrow("block -1 not found")
    })
})

describe("getShard under committeeBinding", () => {
    it("returns the live members of the bound committee in committee order", async () => {
        const committee = await getBoundCommittee(100, "seed")
        const live = new Set([SELF, ...ids(onlinePeers)])
        expect(ids(await getShard("seed", 100))).toEqual(committee.filter(id => live.has(id)))
    })

    it("does not replace an offline member with another pool member", async () => {
        const committee = await getBoundCommittee(100, "seed")
        const offline = committee.find(id => id !== SELF)
        onlinePeers = onlinePeers.filter(p => p.identity !== offline)

        const shard = ids(await getShard("seed", 100))
        expect(shard).not.toContain(offline)
        expect(shard).toHaveLength(committee.length - 1)
        expect(shard.every(id => committee.includes(id))).toBe(true)
    })

    it("draws a subset of one committee whatever each node sees", async () => {
        const committee = await getBoundCommittee(100, "seed")
        onlinePeers = committedPeerlist.slice(1, 4).map(id => onlinePeer(id))
        const sideA = ids(await getShard("seed", 100))
        onlinePeers = committedPeerlist.slice(4).map(id => onlinePeer(id))
        const sideB = ids(await getShard("seed", 100))

        for (const id of [...sideA, ...sideB]) expect(committee).toContain(id)
    })

    it("leaves the pre-fork draw as it was before activation", async () => {
        sharedState.forkConfig = { committeeBinding: { activationHeight: 102 } }
        const committee = await getBoundCommittee(100, "seed")
        const offline = committee.find(id => id !== SELF)
        onlinePeers = onlinePeers.filter(p => p.identity !== offline)

        const shard = ids(await getShard("seed", 100))
        const expected = rankPool("seed", await getEligiblePool(100))
            .filter(id => id !== offline)
            .slice(0, 4)
        expect(shard).toEqual(expected)
        expect(shard).toHaveLength(4)
    })
})
