import getShard, {
    __resetValidatorCache,
    getCommitteeFloor,
    getEligiblePool,
} from "./getShard"

const V = (n: number) => n.toString(16).padStart(2, "0").repeat(32)
const SELF = "aa".repeat(32)

interface FakePeerShape {
    identity: string
    connection: { string: string }
}

let committedPeerlist: string[] = []
let validatorAddresses: (string | null)[] = []
let onlinePeers: FakePeerShape[] = []

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
    },
}))

jest.mock("src/libs/peer/PeerManager", () => {
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
            validatorAddresses.map(address => ({
                address,
                connection_url: null,
            })),
        ),
    },
}))

const onlinePeer = (identity: string): FakePeerShape => ({
    identity,
    connection: { string: `http://${identity.slice(0, 6)}` },
})

beforeEach(() => {
    __resetValidatorCache()
    committedPeerlist = [V(1), V(2), V(3), V(4), V(5), V(6)]
    validatorAddresses = [V(1), V(2), V(3), V(4), V(5), V(6)]
    onlinePeers = committedPeerlist.map(onlinePeer)
})

describe("getEligiblePool", () => {
    it("is deterministic for the same block", async () => {
        const first = await getEligiblePool(100)
        __resetValidatorCache()
        const second = await getEligiblePool(100)
        expect(first).toEqual(second)
        expect(first).toHaveLength(6)
    })

    it("only contains the committed peerlist ∩ validators", async () => {
        validatorAddresses = [V(1), V(2), V(9)]
        const pool = await getEligiblePool(100)
        expect(pool).toEqual([V(1), V(2)])
    })

    it("bootstraps from the validator set when the peerlist is empty", async () => {
        committedPeerlist = []
        const pool = await getEligiblePool(100)
        expect(pool).toHaveLength(6)
        for (const member of pool) {
            expect(validatorAddresses).toContain(member)
        }
    })

    it("normalises case from the committed peerlist", async () => {
        committedPeerlist = [V(1).toUpperCase(), V(2)]
        const pool = await getEligiblePool(100)
        expect(pool).toContain(V(1))
    })
})

describe("getShard", () => {
    it("selects only pool members indexed in the online list", async () => {
        onlinePeers = [onlinePeer(V(1)), onlinePeer(V(2))]
        const shard = await getShard("seed", 100)
        expect(shard.map(p => p.identity).sort()).toEqual([V(1), V(2)])
    })

    it("excludes pool members that are offline", async () => {
        onlinePeers = onlinePeers.filter(p => p.identity !== V(3))
        const shard = await getShard("seed", 100)
        expect(shard.map(p => p.identity)).not.toContain(V(3))
    })

    it("always includes ourselves even when not indexed online", async () => {
        committedPeerlist = [SELF, V(2)]
        validatorAddresses = [SELF, V(2)]
        onlinePeers = []
        const shard = await getShard("seed", 100)
        expect(shard.map(p => p.identity)).toEqual([SELF])
        expect(shard[0].connection.string).toBe("")
    })

    it("is deterministic for the same seed and online set", async () => {
        const first = await getShard("seed-1", 100)
        __resetValidatorCache()
        const second = await getShard("seed-1", 100)
        expect(first.map(p => p.identity)).toEqual(
            second.map(p => p.identity),
        )
    })

    it("draws at most shardSize members", async () => {
        const shard = await getShard("seed", 100)
        expect(shard).toHaveLength(4)
    })

    it("selects different committees for different seeds", async () => {
        const a = await getShard("seed-a", 100)
        const b = await getShard("seed-b", 100)
        expect(a.map(p => p.identity)).not.toEqual(b.map(p => p.identity))
    })
})

describe("getCommitteeFloor", () => {
    it("equals floor(shardSize * 2/3) + 1", () => {
        expect(getCommitteeFloor()).toBe(3)
    })
})
