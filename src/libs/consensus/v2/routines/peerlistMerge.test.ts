import {
    __resetPeerlistMerge,
    computeMergedPeerlist,
    contributePeerlist,
    getLocalSyncObservations,
    MERGE_PEERLIST_MAX_ENTRIES_PER_PEER,
    type SyncObservation,
} from "./peerlistMerge"

const OUR_KEY = "aa".repeat(32)
const SYNCED_PEER = "bb".repeat(32)
const STALE_PEER = "cc".repeat(32)
const REPORTED_PEER = "dd".repeat(32)
const NON_VALIDATOR = "ee".repeat(32)

const TIP_BLOCK = 100
const TIP_HASH = "tiphash"

let validatorAddresses: (string | null)[] = []

const obs = (
    identity: string,
    block: number = TIP_BLOCK,
    block_hash: string = TIP_HASH,
): SyncObservation => ({ identity, block, block_hash })

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
    },
}))

jest.mock("src/libs/peer/PeerManager", () => ({
    __esModule: true,
    default: {
        getInstance: () => ({
            getPeers: () => [
                {
                    identity: "bb".repeat(32),
                    sync: { block: 100, block_hash: "tiphash" },
                },
                {
                    identity: "cc".repeat(32),
                    sync: { block: 99, block_hash: "oldhash" },
                },
            ],
        }),
    },
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
            validatorAddresses.map(address => ({ address })),
        ),
    },
}))

beforeEach(() => {
    __resetPeerlistMerge()
    validatorAddresses = [OUR_KEY, SYNCED_PEER, STALE_PEER, REPORTED_PEER]
})

describe("getLocalSyncObservations", () => {
    it("includes self and tip-synced peers with their sync data, sorted", () => {
        expect(getLocalSyncObservations()).toEqual([
            obs(OUR_KEY),
            obs(SYNCED_PEER),
        ])
    })
})

describe("computeMergedPeerlist", () => {
    it("unions contributions with the local view", async () => {
        contributePeerlist(101, "contributor-1", [obs(REPORTED_PEER)])
        const merged = await computeMergedPeerlist(101)
        expect(merged).toEqual([OUR_KEY, SYNCED_PEER, REPORTED_PEER].sort())
    })

    it("is deterministic regardless of contribution order", async () => {
        contributePeerlist(101, "c1", [obs(REPORTED_PEER), obs(SYNCED_PEER)])
        contributePeerlist(101, "c2", [obs(STALE_PEER)])
        const first = await computeMergedPeerlist(101)

        __resetPeerlistMerge()
        contributePeerlist(101, "c2", [obs(STALE_PEER)])
        contributePeerlist(101, "c1", [obs(SYNCED_PEER), obs(REPORTED_PEER)])
        const second = await computeMergedPeerlist(101)

        expect(first).toEqual(second)
        expect(first).toEqual([...first].sort())
    })

    it("ignores observations that are not at the round's parent block", async () => {
        contributePeerlist(101, "c1", [
            obs(REPORTED_PEER, 99, "oldhash"),
            obs(STALE_PEER, 101, "aheadhash"),
            obs(NON_VALIDATOR, 100, "wronghash"),
        ])
        const merged = await computeMergedPeerlist(101)
        expect(merged).toEqual([OUR_KEY, SYNCED_PEER].sort())
    })

    it("cannot suppress a first-hand at-tip peer with an ahead claim", async () => {
        contributePeerlist(101, "c1", [obs(SYNCED_PEER, 105, "futurehash")])
        const merged = await computeMergedPeerlist(101)
        expect(merged).toContain(SYNCED_PEER)
    })

    it("filters out non-validators", async () => {
        contributePeerlist(101, "c1", [obs(NON_VALIDATOR), obs(REPORTED_PEER)])
        const merged = await computeMergedPeerlist(101)
        expect(merged).not.toContain(NON_VALIDATOR)
        expect(merged).toContain(REPORTED_PEER)
    })

    it("ignores contributions from other rounds", async () => {
        contributePeerlist(101, "c1", [obs(REPORTED_PEER)])
        contributePeerlist(102, "c2", [obs(STALE_PEER, 101, "hash-101")])
        const merged = await computeMergedPeerlist(101)
        expect(merged).not.toContain(REPORTED_PEER)
        expect(merged).not.toContain(STALE_PEER)
    })

    it("returns unfiltered union when no validators exist", async () => {
        validatorAddresses = []
        contributePeerlist(101, "c1", [obs(NON_VALIDATOR)])
        const merged = await computeMergedPeerlist(101)
        expect(merged).toContain(NON_VALIDATOR)
    })

    it("refuses the unfiltered fallback when DEMOS_REQUIRE_VALIDATORS=true", async () => {
        const previous = process.env.DEMOS_REQUIRE_VALIDATORS
        process.env.DEMOS_REQUIRE_VALIDATORS = "true"
        try {
            validatorAddresses = []
            contributePeerlist(101, "c1", [obs(NON_VALIDATOR)])
            await expect(computeMergedPeerlist(101)).rejects.toThrow(
                /DEMOS_REQUIRE_VALIDATORS/,
            )
        } finally {
            if (previous === undefined) {
                delete process.env.DEMOS_REQUIRE_VALIDATORS
            } else {
                process.env.DEMOS_REQUIRE_VALIDATORS = previous
            }
        }
    })
})

describe("contributePeerlist", () => {
    it("accepts 0x-prefixed identities", async () => {
        const prefixed = "0x" + REPORTED_PEER
        validatorAddresses = [OUR_KEY, SYNCED_PEER, prefixed]
        contributePeerlist(101, "c1", [obs(prefixed)])
        const merged = await computeMergedPeerlist(101)
        expect(merged).toContain(prefixed)
    })

    it("normalises 0x-prefixed identity case", async () => {
        const prefixed = "0x" + REPORTED_PEER
        validatorAddresses = [OUR_KEY, SYNCED_PEER, prefixed]
        contributePeerlist(101, "c1", [
            obs("0X" + REPORTED_PEER.toUpperCase()),
        ])
        const merged = await computeMergedPeerlist(101)
        expect(merged).toContain(prefixed)
    })

    it("drops malformed entries and normalises case", async () => {
        contributePeerlist(101, "c1", [
            obs(REPORTED_PEER.toUpperCase()),
            obs("not-hex!"),
            { identity: REPORTED_PEER } as unknown as SyncObservation,
            {
                identity: STALE_PEER,
                block: 100.5,
                block_hash: TIP_HASH,
            } as unknown as SyncObservation,
            { identity: NON_VALIDATOR, block: 100 } as unknown as SyncObservation,
            REPORTED_PEER as unknown as SyncObservation,
            42 as unknown as SyncObservation,
        ])
        const merged = await computeMergedPeerlist(101)
        expect(merged).toContain(REPORTED_PEER)
        expect(merged).toHaveLength(3)
    })

    it("caps entries per contributor", async () => {
        validatorAddresses = []
        const flood = Array.from(
            { length: MERGE_PEERLIST_MAX_ENTRIES_PER_PEER + 50 },
            (_, i) => obs(i.toString(16).padStart(64, "0")),
        )
        contributePeerlist(101, "c1", flood)
        const merged = await computeMergedPeerlist(101)
        expect(merged.length).toBeLessThanOrEqual(
            MERGE_PEERLIST_MAX_ENTRIES_PER_PEER + 2,
        )
    })

    it("replaces a contributor's previous report instead of accumulating", async () => {
        contributePeerlist(101, "c1", [obs(REPORTED_PEER)])
        contributePeerlist(101, "c1", [obs(STALE_PEER)])
        const merged = await computeMergedPeerlist(101)
        expect(merged).not.toContain(REPORTED_PEER)
        expect(merged).toContain(STALE_PEER)
    })

    it("rejects non-integer blockRefs", async () => {
        contributePeerlist("101" as unknown as number, "c1", [
            obs(REPORTED_PEER),
        ])
        contributePeerlist(101.5, "c1", [obs(REPORTED_PEER)])
        const merged = await computeMergedPeerlist(101)
        expect(merged).not.toContain(REPORTED_PEER)
    })
})
