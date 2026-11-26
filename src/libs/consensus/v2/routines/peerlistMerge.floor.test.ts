import { getSharedState } from "src/utilities/sharedState"
import {
    __resetPeerlistMerge,
    computeMergedPeerlist,
    contributePeerlist,
    validateMergedPeerlist,
    type SyncObservation,
} from "./peerlistMerge"

// A 10-seat bound committee: us, 5 honest members and 4 colluders.
const OUR_KEY = "aa".repeat(32)
const HONEST = "bb".repeat(32) // online validator outside the committee
const COLLUDER_KEY = "cc".repeat(32) // offline key only the colluders vouch for
const HONEST_MEMBERS = ["d1", "d2", "d3", "d4", "d5"]
const COLLUDERS = ["e1", "e2", "e3", "e4"]
const COMMITTEE = [OUR_KEY, ...HONEST_MEMBERS, ...COLLUDERS]

let peers: { identity: string; sync: { block: number; block_hash: string } }[] = []

const obs = (identity: string): SyncObservation => ({
    identity,
    block: 100,
    block_hash: "tiphash",
})

jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        only: jest.fn(),
    },
}))

jest.mock("src/utilities/sharedState", () => ({
    getSharedState: {
        publicKeyHex: "aa".repeat(32),
        lastBlockNumber: 100,
        lastBlockHash: "tiphash",
        shardSize: 10,
        forkConfig: {
            committeeBinding: { activationHeight: 0 },
            peerlistFloor: { activationHeight: null },
        },
    },
}))

jest.mock("src/libs/peer/PeerManager", () => ({
    __esModule: true,
    default: { getInstance: () => ({ getPeers: () => peers }) },
}))

jest.mock("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: {
        getBlockByNumber: jest.fn(async (n: number) =>
            n === 100 ? { number: 100, hash: "tiphash" } : null,
        ),
    },
}))

jest.mock("src/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: {
        getGCRValidatorsAtBlock: jest.fn(async () =>
            ["aa".repeat(32), "bb".repeat(32), "cc".repeat(32)].map(address => ({ address })),
        ),
    },
}))

/** Honest members report us and HONEST; colluders report us and their own key only. */
function contributeWithholding(): void {
    for (const member of HONEST_MEMBERS) {
        contributePeerlist(101, member, [obs(OUR_KEY), obs(HONEST)])
    }
    for (const colluder of COLLUDERS) {
        contributePeerlist(101, colluder, [obs(OUR_KEY), obs(COLLUDER_KEY)])
    }
}

const withHonest = [OUR_KEY, HONEST].sort()
const withColluderKey = [OUR_KEY, HONEST, COLLUDER_KEY].sort()

beforeEach(() => {
    __resetPeerlistMerge()
    getSharedState.forkConfig.peerlistFloor.activationHeight = null
    peers = [{ identity: HONEST, sync: { block: 100, block_hash: "tiphash" } }]
    contributeWithholding()
})

describe("4 colluders that leave an honest validator out of their reports", () => {
    it("drop it before peerlistFloor: 6 honest reports are below the quorum of 7", async () => {
        expect(await computeMergedPeerlist(101, COMMITTEE)).toEqual([OUR_KEY])
        expect(await validateMergedPeerlist(101, [OUR_KEY], COMMITTEE)).toEqual([OUR_KEY])
        expect(await validateMergedPeerlist(101, withHonest, COMMITTEE)).toBeNull()
    })

    it("cannot drop it under peerlistFloor: 6 reports clear the floor of 4", async () => {
        getSharedState.forkConfig.peerlistFloor.activationHeight = 0
        expect(await computeMergedPeerlist(101, COMMITTEE)).toEqual(withColluderKey)
        expect(await validateMergedPeerlist(101, withColluderKey, COMMITTEE)).toEqual(withColluderKey)
    })

    it("cannot get a list without it past an honest member under peerlistFloor", async () => {
        getSharedState.forkConfig.peerlistFloor.activationHeight = 0
        expect(await validateMergedPeerlist(101, [OUR_KEY, COLLUDER_KEY].sort(), COMMITTEE)).toBeNull()
        expect(await validateMergedPeerlist(101, [OUR_KEY], COMMITTEE)).toBeNull()
    })
})

describe("the floor of n - q + 1", () => {
    beforeEach(() => {
        getSharedState.forkConfig.peerlistFloor.activationHeight = 0
    })

    it("leaves out an identity 3 members report, and a member refuses it listed", async () => {
        __resetPeerlistMerge()
        for (const member of HONEST_MEMBERS) {
            contributePeerlist(101, member, [obs(OUR_KEY), obs(HONEST)])
        }
        for (const colluder of COLLUDERS.slice(0, 3)) {
            contributePeerlist(101, colluder, [obs(OUR_KEY), obs(COLLUDER_KEY)])
        }
        expect(await computeMergedPeerlist(101, COMMITTEE)).toEqual(withHonest)
        expect(await validateMergedPeerlist(101, withColluderKey, COMMITTEE)).toBeNull()
        expect(await validateMergedPeerlist(101, withHonest, COMMITTEE)).toEqual(withHonest)
    })

    it("lets 4 members keep a key nobody else sees, the accepted cost of the floor", async () => {
        expect(await computeMergedPeerlist(101, COMMITTEE)).toContain(COLLUDER_KEY)
    })

    it("applies from the activation height of the block being forged", async () => {
        getSharedState.forkConfig.peerlistFloor.activationHeight = 102
        expect(await computeMergedPeerlist(101, COMMITTEE)).toEqual([OUR_KEY])
        getSharedState.forkConfig.peerlistFloor.activationHeight = 101
        expect(await computeMergedPeerlist(101, COMMITTEE)).toEqual(withColluderKey)
    })
})
