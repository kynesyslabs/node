import getShard, {
    __resetValidatorCache,
    getCommitteeFloor,
    getShardIdentities,
} from "./getShard"
import { computeCurrentSlot, pickSlotLeader } from "./slotRotation"

const V = (n: number) => n.toString(16).padStart(2, "0").repeat(32)

let committedPeerlist: string[] = []
let validatorAddresses: (string | null)[] = []
let networkNow = 1_000_000

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
    getSharedState: {
        publicKeyHex: "aa".repeat(32),
        lastBlockNumber: 100,
        lastBlockHash: "tiphash",
        shardSize: 4,
        getSlotDuration: () => 30,
        getConsensusTime: () => 10,
    },
}))

jest.mock("src/libs/utils/calibrateTime", () => ({
    getNetworkTimestamp: () => networkNow,
}))

jest.mock("src/libs/peer/PeerManager", () => {
    class FakePeerManager {
        static getInstance() {
            return new FakePeerManager()
        }
        getPeers() {
            return []
        }
        getPeer(identity: string) {
            if (identity === "bb".repeat(32)) {
                return { identity, connection: { string: "http://known" } }
            }
            return undefined
        }
    }
    return { __esModule: true, default: FakePeerManager }
})

jest.mock("src/libs/peer", () => {
    class FakePeer {
        connection: { string: string }
        identity: string
        constructor(url = "", publicKey = "") {
            this.connection = { string: url }
            this.identity = publicKey
        }
    }
    const peerManagerMock = jest.requireMock(
        "src/libs/peer/PeerManager",
    ).default
    return { Peer: FakePeer, PeerManager: peerManagerMock }
})

jest.mock("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: {
        getBlockByNumber: jest.fn(async (n: number) => ({
            number: n,
            hash: `hash-${n}`,
            content: { peerlist: committedPeerlist, timestamp: 999_000 },
        })),
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

beforeEach(() => {
    __resetValidatorCache()
    committedPeerlist = [V(1), V(2), V(3), V(4), V(5), V(6)]
    validatorAddresses = [V(1), V(2), V(3), V(4), V(5), V(6)]
    networkNow = 1_000_000
})

describe("getShardIdentities", () => {
    it("is deterministic for the same seed and block", async () => {
        const first = await getShardIdentities("seed-1", 100)
        __resetValidatorCache()
        const second = await getShardIdentities("seed-1", 100)
        expect(first).toEqual(second)
        expect(first).toHaveLength(4)
    })

    it("selects different committees for different seeds", async () => {
        const a = await getShardIdentities("seed-a", 100)
        const b = await getShardIdentities("seed-b", 100)
        expect(a).not.toEqual(b)
    })

    it("only selects members from the committed peerlist ∩ validators", async () => {
        validatorAddresses = [V(1), V(2), V(9)]
        const committee = await getShardIdentities("seed", 100)
        expect(committee.sort()).toEqual([V(1), V(2)])
    })

    it("bootstraps from the validator set when the peerlist is empty", async () => {
        committedPeerlist = []
        const committee = await getShardIdentities("seed", 100)
        expect(committee).toHaveLength(4)
        for (const member of committee) {
            expect(validatorAddresses).toContain(member)
        }
    })

    it("returns the whole pool when it is smaller than shardSize", async () => {
        committedPeerlist = [V(1), V(2)]
        const committee = await getShardIdentities("seed", 100)
        expect(committee.sort()).toEqual([V(1), V(2)])
    })

    it("normalises case from the committed peerlist", async () => {
        committedPeerlist = [V(1).toUpperCase(), V(2)]
        const committee = await getShardIdentities("seed", 100)
        expect(committee).toContain(V(1))
    })
})

describe("getShard", () => {
    it("resolves unknown identities to placeholder peers instead of dropping them", async () => {
        committedPeerlist = ["bb".repeat(32), "cc".repeat(32)]
        validatorAddresses = ["bb".repeat(32), "cc".repeat(32)]
        const shard = await getShard("seed", 100)
        expect(shard).toHaveLength(2)
        const unknown = shard.find(p => p.identity === "cc".repeat(32))
        expect(unknown).toBeDefined()
        expect(unknown.connection.string).toBe("")
        const known = shard.find(p => p.identity === "bb".repeat(32))
        expect(known.connection.string).toBe("http://known")
    })
})

describe("getCommitteeFloor", () => {
    it("equals floor(shardSize * 2/3) + 1", () => {
        expect(getCommitteeFloor()).toBe(3)
    })
})

describe("slotRotation", () => {
    it("is slot 0 before the origin has elapsed", () => {
        networkNow = 999_000 + 10
        expect(computeCurrentSlot(999_000)).toBe(0)
    })

    it("advances one slot per slotDuration after the origin", () => {
        networkNow = 999_000 + 10 + 65
        expect(computeCurrentSlot(999_000)).toBe(2)
    })

    it("rotates the leader deterministically with wraparound", () => {
        const committee = ["a", "b", "c"]
        expect(pickSlotLeader(committee, 0)).toBe("a")
        expect(pickSlotLeader(committee, 2)).toBe("c")
        expect(pickSlotLeader(committee, 3)).toBe("a")
        expect(pickSlotLeader([], 5)).toBeNull()
    })
})
