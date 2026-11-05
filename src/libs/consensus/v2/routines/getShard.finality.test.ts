/**
 * Under finalityProofs the pool for block N + 1 is the peerlist of block N
 * intersected with the validator set after block N - 1, read from its
 * snapshot. Block N commits the hash of exactly that set, so a client that
 * trusts block N knows who may sign block N + 1. The live validators table
 * holds only the present and must not be read.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"

const V = (n: number) => "0x" + n.toString(16).padStart(2, "0").repeat(32)
const [A, B, C, D, E] = [V(1), V(2), V(3), V(4), V(5)]

interface Entry {
    identity: string
    stake: string
    status: string | null
    validAt: number | null
}

const active = (identity: string, validAt = 0): Entry => ({
    identity,
    stake: "1000",
    status: "2",
    validAt,
})
const exited = (identity: string): Entry => ({
    identity,
    stake: "0",
    status: "0",
    validAt: 0,
})

let peerlistAt: Record<number, string[]> = {}
let snapshots = new Map<number, Entry[]>()
let liveValidators: string[] = []

const sharedState: Record<string, any> = {
    publicKeyHex: A,
    lastBlockNumber: 10,
    lastBlockHash: "hash-10",
    shardSize: 4,
    forkConfig: {},
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
        return []
    }
    getPeers() {
        return []
    }
    getPeer() {
        return undefined
    }
}
jest.mock("src/libs/peer/PeerManager", () => ({
    __esModule: true,
    default: FakePeerManager,
}))
jest.mock("src/libs/peer", () => ({ Peer: class {}, PeerManager: FakePeerManager }))
jest.mock("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: {
        getBlockByNumber: jest.fn(async (n: number) => ({
            number: n,
            hash: `hash-${n}`,
            content: { peerlist: n === 0 ? [] : peerlistAt[n] ?? [], timestamp: 1000 + n },
        })),
    },
}))
const getGCRValidatorsAtBlock = jest.fn(async () =>
    liveValidators.map(address => ({ address })),
)
jest.mock("src/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: { getGCRValidatorsAtBlock },
}))

const realValidatorSet = await import("src/libs/blockchain/finality/validatorSet")
const validatorSetAt = jest.fn(async (height: number) => {
    const at = [...snapshots.keys()].filter(b => b <= height).sort((x, y) => y - x)[0]
    return at === undefined
        ? null
        : { block: at, setHash: `set-${at}`, validators: snapshots.get(at) }
})
jest.mock("src/libs/blockchain/finality/validatorSet", () => ({
    ...realValidatorSet,
    validatorSetAt,
}))

const {
    __resetValidatorCache: resetPoolCache,
    getBoundPool,
    getEligiblePool,
} = await import("./getShard")

const fork = (activationHeight: number | null) => {
    sharedState.forkConfig = {
        committeeBinding: { activationHeight: 0 },
        finalityProofs: { activationHeight },
    }
}

beforeEach(() => {
    resetPoolCache()
    fork(0)
    peerlistAt = {}
    snapshots = new Map([[0, [active(A), active(B), active(C), active(D)]]])
    // The present, which already holds what later blocks did
    liveValidators = [A, B, C, D, E]
    getGCRValidatorsAtBlock.mockClear()
    validatorSetAt.mockClear()
})

describe("pool boundaries under finalityProofs", () => {
    it("block 1 is drawn from the genesis set: block 0 commits no peerlist", async () => {
        expect(await getBoundPool(0)).toEqual([A, B, C, D])
        expect(validatorSetAt).toHaveBeenLastCalledWith(0)
        expect(getGCRValidatorsAtBlock).not.toHaveBeenCalled()
    })

    it("block 2 filters block 1's peerlist by the genesis set", async () => {
        peerlistAt[1] = [A, B, C, E]
        expect(await getBoundPool(1)).toEqual([A, B, C])
        expect(validatorSetAt).toHaveBeenLastCalledWith(0)
    })

    it("block 3 filters block 2's peerlist by the set after block 1", async () => {
        peerlistAt[2] = [A, B, C, D, E]
        snapshots.set(1, [active(A), active(B), active(C), active(E, 1)])
        expect(await getBoundPool(2)).toEqual([A, B, C, E])
        expect(validatorSetAt).toHaveBeenLastCalledWith(1)
    })

    it("reads the set block N commits to when drawing the pool for N + 1", async () => {
        // Block 7 commits validator_set_hash = set after block 6
        peerlistAt[7] = [A, B, C, D]
        await getEligiblePool(7)
        expect(validatorSetAt).toHaveBeenLastCalledWith(6)
    })
})

describe("a stake change", () => {
    beforeEach(() => {
        for (const n of [4, 5, 6, 7]) peerlistAt[n] = [A, B, C, D, E]
        // E stakes and D exits in block 5
        snapshots.set(5, [active(A), active(B), active(C), exited(D), active(E, 4)])
    })

    it("reaches the pool one block after the block that carried it", async () => {
        // Block 6 (parent 5) is still drawn from the set after block 4
        expect(await getBoundPool(5)).toEqual([A, B, C, D])
        // Block 7 (parent 6) sees the set after block 5
        expect(await getBoundPool(6)).toEqual([A, B, C, E])
    })

    it("draws the same pool whatever the live table says now", async () => {
        liveValidators = [A]
        expect(await getBoundPool(5)).toEqual([A, B, C, D])
        expect(await getBoundPool(6)).toEqual([A, B, C, E])
    })

    it("keeps an identity out until its validAt", async () => {
        snapshots.set(5, [active(A), active(B), active(C), active(D), active(E, 9)])
        expect(await getBoundPool(6)).toEqual([A, B, C, D])
    })
})

describe("snapshot availability", () => {
    it("refuses to draw a pool without a snapshot that old", async () => {
        snapshots = new Map([[3, [active(A), active(B), active(C)]]])
        peerlistAt[2] = [A, B, C]
        await expect(getBoundPool(2)).rejects.toThrow("no validator set snapshot")
    })

    it("keeps reading the live table before the fork", async () => {
        fork(8)
        peerlistAt[6] = [A, B, C, D, E]
        expect(await getBoundPool(6)).toEqual([A, B, C, D, E])
        expect(validatorSetAt).not.toHaveBeenCalled()

        // Block 8 is the first drawn from a snapshot
        peerlistAt[7] = [A, B, C, D, E]
        expect(await getBoundPool(7)).toEqual([A, B, C, D])
        expect(validatorSetAt).toHaveBeenLastCalledWith(6)
    })
})
