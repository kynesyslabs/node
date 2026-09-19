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

const SHARD = [OUR_KEY, "c1", "c2", "c3"] // quorum = floor(4*2/3)+1 = 3
const SOLO = ["c1"] // quorum = 1: isolates contribution parsing
const merge = (shard: string[] = SHARD, ref = 101) =>
    computeMergedPeerlist(ref, shard)

describe("computeMergedPeerlist", () => {
    it("includes identities seen by 2/3 + 1 of the shard", async () => {
        // us + c1 + c2 see OUR_KEY and SYNCED_PEER; c1 + c2 + c3 see REPORTED_PEER
        contributePeerlist(101, "c1", [obs(OUR_KEY), obs(SYNCED_PEER), obs(REPORTED_PEER)])
        contributePeerlist(101, "c2", [obs(OUR_KEY), obs(SYNCED_PEER), obs(REPORTED_PEER)])
        contributePeerlist(101, "c3", [obs(REPORTED_PEER)])
        const merged = await merge()
        expect(merged).toEqual([OUR_KEY, SYNCED_PEER, REPORTED_PEER].sort())
    })

    it("excludes identities below quorum, including ourselves", async () => {
        contributePeerlist(101, "c1", [obs(REPORTED_PEER)])
        const merged = await merge()
        expect(merged).toEqual([])
    })

    it("ignores contributions from non-members", async () => {
        contributePeerlist(101, "c1", [obs(REPORTED_PEER)])
        contributePeerlist(101, "c2", [obs(REPORTED_PEER)])
        contributePeerlist(101, "outsider", [obs(REPORTED_PEER)])
        expect(await merge()).toEqual([])
        contributePeerlist(101, "c3", [obs(REPORTED_PEER)])
        expect(await merge()).toEqual([REPORTED_PEER])
    })

    it("counts absent members against the quorum", async () => {
        contributePeerlist(101, "c1", [obs(OUR_KEY), obs(SYNCED_PEER)])
        const merged = await merge()
        expect(merged).toEqual([])
    })

    it("is deterministic regardless of contribution order", async () => {
        contributePeerlist(101, "c1", [obs(REPORTED_PEER), obs(SYNCED_PEER)])
        contributePeerlist(101, "c2", [obs(SYNCED_PEER), obs(REPORTED_PEER)])
        const first = await merge()

        __resetPeerlistMerge()
        contributePeerlist(101, "c2", [obs(REPORTED_PEER), obs(SYNCED_PEER)])
        contributePeerlist(101, "c1", [obs(SYNCED_PEER), obs(REPORTED_PEER)])
        const second = await merge()

        expect(first).toEqual(second)
        expect(first).toEqual([...first].sort())
    })

    it("ignores observations that are not at the round's parent block", async () => {
        for (const c of ["c1", "c2", "c3"]) {
            contributePeerlist(101, c, [
                obs(REPORTED_PEER, 99, "oldhash"),
                obs(STALE_PEER, 101, "aheadhash"),
                obs(NON_VALIDATOR, 100, "wronghash"),
            ])
        }
        const merged = await merge()
        expect(merged).toEqual([])
    })

    it("treats one member's ahead claim as a missing vote, not a veto", async () => {
        contributePeerlist(101, "c1", [obs(SYNCED_PEER, 105, "futurehash")])
        contributePeerlist(101, "c2", [obs(SYNCED_PEER)])
        contributePeerlist(101, "c3", [obs(SYNCED_PEER)])
        const merged = await merge()
        expect(merged).toContain(SYNCED_PEER)
    })

    it("filters out non-validators", async () => {
        for (const c of ["c1", "c2", "c3"]) {
            contributePeerlist(101, c, [obs(NON_VALIDATOR), obs(REPORTED_PEER)])
        }
        const merged = await merge()
        expect(merged).not.toContain(NON_VALIDATOR)
        expect(merged).toContain(REPORTED_PEER)
    })

    it("ignores contributions from other rounds", async () => {
        contributePeerlist(101, "c1", [obs(REPORTED_PEER)])
        contributePeerlist(102, "c2", [obs(STALE_PEER, 101, "hash-101")])
        const merged = await merge()
        expect(merged).not.toContain(REPORTED_PEER)
        expect(merged).not.toContain(STALE_PEER)
    })

    it("returns the unfiltered quorum set when no validators exist", async () => {
        validatorAddresses = []
        contributePeerlist(101, "c1", [obs(NON_VALIDATOR)])
        const merged = await merge(SOLO)
        expect(merged).toContain(NON_VALIDATOR)
    })

    it("refuses the unfiltered fallback when DEMOS_REQUIRE_VALIDATORS=true", async () => {
        const previous = process.env.DEMOS_REQUIRE_VALIDATORS
        process.env.DEMOS_REQUIRE_VALIDATORS = "true"
        try {
            validatorAddresses = []
            contributePeerlist(101, "c1", [obs(NON_VALIDATOR)])
            await expect(merge(SOLO)).rejects.toThrow(
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
        const merged = await merge(SOLO)
        expect(merged).toContain(prefixed)
    })

    it("normalises 0x-prefixed identity case", async () => {
        const prefixed = "0x" + REPORTED_PEER
        validatorAddresses = [OUR_KEY, SYNCED_PEER, prefixed]
        contributePeerlist(101, "c1", [
            obs("0X" + REPORTED_PEER.toUpperCase()),
        ])
        const merged = await merge(SOLO)
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
        const merged = await merge(SOLO)
        expect(merged).toEqual([REPORTED_PEER])
    })

    it("caps entries per contributor", async () => {
        validatorAddresses = []
        const flood = Array.from(
            { length: MERGE_PEERLIST_MAX_ENTRIES_PER_PEER + 50 },
            (_, i) => obs(i.toString(16).padStart(64, "0")),
        )
        contributePeerlist(101, "c1", flood)
        const merged = await merge(SOLO)
        expect(merged.length).toBeLessThanOrEqual(
            MERGE_PEERLIST_MAX_ENTRIES_PER_PEER,
        )
    })

    it("replaces a contributor's previous report instead of accumulating", async () => {
        contributePeerlist(101, "c1", [obs(REPORTED_PEER)])
        contributePeerlist(101, "c1", [obs(STALE_PEER)])
        const merged = await merge(SOLO)
        expect(merged).not.toContain(REPORTED_PEER)
        expect(merged).toContain(STALE_PEER)
    })

    it("rejects non-integer blockRefs", async () => {
        contributePeerlist("101" as unknown as number, "c1", [
            obs(REPORTED_PEER),
        ])
        contributePeerlist(101.5, "c1", [obs(REPORTED_PEER)])
        const merged = await merge(SOLO)
        expect(merged).not.toContain(REPORTED_PEER)
    })
})
