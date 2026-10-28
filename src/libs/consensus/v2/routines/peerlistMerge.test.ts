import { getSharedState } from "src/utilities/sharedState"
import {
    __resetPeerlistMerge,
    computeMergedPeerlist,
    contributePeerlist,
    freezeLocalSyncObservations,
    getLocalSyncObservations,
    MERGE_PEERLIST_MAX_ENTRIES_PER_PEER,
    validateMergedPeerlist,
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
let peers: { identity: string; sync: { block: number; block_hash: string } }[] =
    []

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
        shardSize: 4,
        forkConfig: { committeeBinding: { activationHeight: null } },
    },
}))

jest.mock("src/libs/peer/PeerManager", () => ({
    __esModule: true,
    default: {
        getInstance: () => ({
            getPeers: () => peers,
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
    getSharedState.forkConfig.committeeBinding.activationHeight = null
    Object.assign(getSharedState, { shardSize: 4 })
    validatorAddresses = [OUR_KEY, SYNCED_PEER, STALE_PEER, REPORTED_PEER]
    peers = [
        { identity: SYNCED_PEER, sync: { block: 100, block_hash: "tiphash" } },
        { identity: STALE_PEER, sync: { block: 99, block_hash: "oldhash" } },
    ]
})

describe("getLocalSyncObservations", () => {
    it("includes self and tip-synced peers with their sync data, sorted", () => {
        expect(getLocalSyncObservations()).toEqual([
            obs(OUR_KEY),
            obs(SYNCED_PEER),
        ])
    })

    it("returns the frozen snapshot for the round even after the view changes", () => {
        freezeLocalSyncObservations(101)
        peers[1].sync = { block: 100, block_hash: "tiphash" }
        expect(getLocalSyncObservations(101)).toEqual([
            obs(OUR_KEY),
            obs(SYNCED_PEER),
        ])
        expect(getLocalSyncObservations(102)).toEqual([
            obs(OUR_KEY),
            obs(SYNCED_PEER),
            obs(STALE_PEER),
        ])
        expect(getLocalSyncObservations()).toHaveLength(3)
    })
})

describe("validateMergedPeerlist", () => {
    it("accepts a sorted, unique list of staked validators", async () => {
        const list = [OUR_KEY, SYNCED_PEER].sort()
        expect(await validateMergedPeerlist(101, list)).toEqual(list)
    })

    it("accepts an empty list", async () => {
        expect(await validateMergedPeerlist(101, [])).toEqual([])
    })

    it("rejects unsorted, duplicated, upper-case or malformed entries", async () => {
        expect(await validateMergedPeerlist(101, [SYNCED_PEER, OUR_KEY])).toBeNull()
        expect(await validateMergedPeerlist(101, [OUR_KEY, OUR_KEY])).toBeNull()
        expect(
            await validateMergedPeerlist(101, [OUR_KEY.toUpperCase()]),
        ).toBeNull()
        expect(await validateMergedPeerlist(101, ["zz"])).toBeNull()
        expect(await validateMergedPeerlist(101, "nope")).toBeNull()
    })

    it("rejects identities outside the validator set", async () => {
        expect(
            await validateMergedPeerlist(101, [OUR_KEY, NON_VALIDATOR].sort()),
        ).toBeNull()
    })

    it("skips the validator filter when no validators exist", async () => {
        validatorAddresses = []
        expect(await validateMergedPeerlist(101, [NON_VALIDATOR])).toEqual([
            NON_VALIDATOR,
        ])
    })

    describe("held to our contributions when the shard is given", () => {
        const shard = [OUR_KEY, "c1", "c2", "c3"] // quorum 3
        beforeEach(() => {
            // us + c1 + c2 see OUR_KEY and SYNCED_PEER (quorum); only c1 + c2
            // see REPORTED_PEER (vouched, below quorum); nobody sees STALE_PEER.
            contributePeerlist(101, "c1", [obs(OUR_KEY), obs(SYNCED_PEER), obs(REPORTED_PEER)])
            contributePeerlist(101, "c2", [obs(OUR_KEY), obs(SYNCED_PEER), obs(REPORTED_PEER)])
        })

        it("accepts the list we would compute ourselves", async () => {
            const list = [OUR_KEY, SYNCED_PEER].sort()
            expect(await validateMergedPeerlist(101, list, shard)).toEqual(list)
        })

        it("before committeeBinding, accepts extra identities some member observed at the parent", async () => {
            const list = [OUR_KEY, SYNCED_PEER, REPORTED_PEER].sort()
            expect(await validateMergedPeerlist(101, list, shard)).toEqual(list)
        })

        describe("under committeeBinding", () => {
            beforeEach(() => {
                getSharedState.forkConfig.committeeBinding.activationHeight = 0
            })

            it("accepts exactly the identities at quorum in our view", async () => {
                const list = [OUR_KEY, SYNCED_PEER].sort()
                expect(await validateMergedPeerlist(101, list, shard)).toEqual(list)
                expect(await computeMergedPeerlist(101, shard)).toEqual(list)
            })

            it("rejects an identity observed below quorum, so the secretary has nothing to choose", async () => {
                const list = [OUR_KEY, SYNCED_PEER, REPORTED_PEER].sort()
                expect(await validateMergedPeerlist(101, list, shard)).toBeNull()
            })

            it("accepts the identity once it reaches quorum", async () => {
                contributePeerlist(101, "c3", [obs(REPORTED_PEER)])
                const list = [OUR_KEY, SYNCED_PEER, REPORTED_PEER].sort()
                expect(await validateMergedPeerlist(101, list, shard)).toEqual(list)
            })

            it("rejects an entry the secretary saw at quorum through a contribution we lack", async () => {
                // The secretary also holds c3's table naming REPORTED_PEER;
                // ours misses it, so in our view the entry is optional.
                const list = [OUR_KEY, SYNCED_PEER, REPORTED_PEER].sort()
                expect(await validateMergedPeerlist(101, list, shard)).toBeNull()
            })

            it("still rejects a list that drops an identity at quorum", async () => {
                expect(await validateMergedPeerlist(101, [OUR_KEY], shard)).toBeNull()
            })

            it("applies from the activation height of the block being forged", async () => {
                const list = [OUR_KEY, SYNCED_PEER, REPORTED_PEER].sort()
                getSharedState.forkConfig.committeeBinding.activationHeight = 102
                expect(await validateMergedPeerlist(101, list, shard)).toEqual(list)
                getSharedState.forkConfig.committeeBinding.activationHeight = 101
                expect(await validateMergedPeerlist(101, list, shard)).toBeNull()
            })

            it("does not apply without the shard", async () => {
                const list = [OUR_KEY, SYNCED_PEER, REPORTED_PEER].sort()
                expect(await validateMergedPeerlist(101, list)).toEqual(list)
            })
        })

        describe("quorum when nodes see different live members (committeeBinding)", () => {
            // shardSize 10, so the bar is 7 whatever the voter list holds.
            const committee = [OUR_KEY, ...Array.from({ length: 9 }, (_, i) => `c${i + 1}`)]
            const secretaryLive = committee.slice(0, 8) // 8 live: own-count bar would be 6
            const memberLive = committee // all 10 live: own-count bar would be 7

            beforeEach(() => {
                __resetPeerlistMerge()
                Object.assign(getSharedState, { shardSize: 10 })
                getSharedState.forkConfig.committeeBinding.activationHeight = 0
                // Seen by us + c1..c6 (7): at the bar. Seen by c1..c6 (6): below it.
                for (const c of ["c1", "c2", "c3", "c4", "c5", "c6"]) {
                    contributePeerlist(101, c, [obs(OUR_KEY), obs(SYNCED_PEER), obs(REPORTED_PEER)])
                }
                peers = [{ identity: SYNCED_PEER, sync: { block: 100, block_hash: "tiphash" } }]
            })

            it("secretary and member hold entries to the same bar", async () => {
                const list = await computeMergedPeerlist(101, secretaryLive)
                expect(list).toEqual([OUR_KEY, SYNCED_PEER].sort())
                expect(await validateMergedPeerlist(101, list, memberLive)).toEqual(list)
                expect(await validateMergedPeerlist(101, list, secretaryLive)).toEqual(list)
            })

            it("neither side lets a smaller live view lower the bar", async () => {
                const withReported = [OUR_KEY, SYNCED_PEER, REPORTED_PEER].sort()
                expect(await validateMergedPeerlist(101, withReported, secretaryLive)).toBeNull()
                expect(await validateMergedPeerlist(101, withReported, memberLive)).toBeNull()
            })

            it("before the fork, the bar still follows the voter count", async () => {
                getSharedState.forkConfig.committeeBinding.activationHeight = null
                expect(await computeMergedPeerlist(101, secretaryLive)).toEqual(
                    [OUR_KEY, SYNCED_PEER, REPORTED_PEER].sort(),
                )
                expect(await computeMergedPeerlist(101, memberLive)).toEqual([OUR_KEY, SYNCED_PEER].sort())
            })
        })

        it("rejects a list that drops an identity at quorum in our view", async () => {
            expect(await validateMergedPeerlist(101, [OUR_KEY], shard)).toBeNull()
            expect(await validateMergedPeerlist(101, [], shard)).toBeNull()
        })

        it("does not require an unstaked identity the shard observed at quorum", async () => {
            validatorAddresses = [OUR_KEY, SYNCED_PEER]
            contributePeerlist(101, "c1", [obs(OUR_KEY), obs(SYNCED_PEER), obs(REPORTED_PEER)])
            contributePeerlist(101, "c2", [obs(OUR_KEY), obs(SYNCED_PEER), obs(REPORTED_PEER)])
            contributePeerlist(101, "c3", [obs(OUR_KEY), obs(SYNCED_PEER), obs(REPORTED_PEER)])
            const list = [OUR_KEY, SYNCED_PEER].sort()
            expect(await computeMergedPeerlist(101, shard)).toEqual(list)
            expect(await validateMergedPeerlist(101, list, shard)).toEqual(list)
        })

        it("rejects an identity nobody observed at the parent block", async () => {
            const list = [OUR_KEY, SYNCED_PEER, STALE_PEER].sort()
            expect(await validateMergedPeerlist(101, list, shard)).toBeNull()
        })

        it("does not apply without the shard", async () => {
            expect(await validateMergedPeerlist(101, [OUR_KEY])).toEqual([OUR_KEY])
        })
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
