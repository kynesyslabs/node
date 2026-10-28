/**
 * A validator's signed height claim stops consensus only while sync can
 * still expect to download it. Once the peer fails to serve, its claims
 * are ignored until it serves or the window lapses; what other nodes
 * corroborated about it still counts.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"

const sharedState = { lastBlockNumber: 100 }
let onlinePeers: any[] = []
let staked = new Set<string>(["liar", "honest"])

jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn() },
}))
jest.mock("src/utilities/sharedState", () => ({ getSharedState: sharedState }))
jest.mock("src/libs/peer", () => ({
    PeerManager: { getInstance: () => ({ getOnlinePeers: async () => onlinePeers }) },
}))
jest.mock("src/libs/consensus/stakedSet", () => ({ getStakedSet: async () => staked }))

const {
    DISCREDIT_MS,
    clearDiscreditedHeights,
    creditAdvertisedHeight,
    creditVerifiedHeight,
    credibleHeight,
    discreditAdvertisedHeight,
    getAheadValidatorPeers,
} = await import("./networkAheadVeto")

const peer = (identity: string, sync: number, gossip: number): any => ({
    identity,
    connection: { string: identity },
    sync: { block: sync },
    gossip: { height: gossip },
})

beforeEach(() => {
    clearDiscreditedHeights()
    sharedState.lastBlockNumber = 100
    onlinePeers = []
    staked = new Set(["liar", "honest"])
})

describe("credibleHeight", () => {
    it("takes the higher of corroborated and advertised", () => {
        expect(credibleHeight(peer("p", 100, 150))).toBe(150)
        expect(credibleHeight(peer("p", 100, 0))).toBe(100)
    })

    it("ignores the whole claim after a failed serve, even when it is bumped", () => {
        const liar = peer("liar", 100, 150)
        discreditAdvertisedHeight(liar)
        expect(credibleHeight(liar)).toBe(100)
        liar.gossip.height = 151
        expect(credibleHeight(liar)).toBe(100)
        liar.gossip.height = 10_000
        expect(credibleHeight(liar)).toBe(100)
    })

    it("still counts what was corroborated", () => {
        const liar = peer("liar", 100, 150)
        discreditAdvertisedHeight(liar)
        liar.sync.block = 103
        expect(credibleHeight(liar)).toBe(103)
    })

    it("counts the claim again when the peer serves, or when the window lapses", () => {
        const liar = peer("liar", 100, 150)
        discreditAdvertisedHeight(liar)
        expect(credibleHeight(liar, Date.now() + DISCREDIT_MS + 1)).toBe(150)

        discreditAdvertisedHeight(liar)
        creditAdvertisedHeight(liar)
        expect(credibleHeight(liar)).toBe(150)
    })

    it("does not discredit a peer whose claim we already reached", () => {
        const honest = peer("honest", 100, 100)
        discreditAdvertisedHeight(honest)
        honest.gossip.height = 120
        expect(credibleHeight(honest)).toBe(120)
    })
})

describe("heights backed by a verified block", () => {
    it("count with gossip off, where nothing else lifts a peer above our head", () => {
        const ahead = peer("honest", 100, 0)
        expect(credibleHeight(ahead)).toBe(100)
        creditVerifiedHeight(ahead, 117)
        expect(credibleHeight(ahead)).toBe(117)
        creditVerifiedHeight(ahead, 110)
        expect(credibleHeight(ahead)).toBe(117)
    })

    it("are dropped when the peer then fails to serve them", () => {
        const liar = peer("liar", 100, 0)
        creditVerifiedHeight(liar, 500)
        discreditAdvertisedHeight(liar)
        expect(credibleHeight(liar)).toBe(100)
        expect(credibleHeight(liar, Date.now() + DISCREDIT_MS + 1)).toBe(100)
    })

    it("make a staked peer count as ahead", async () => {
        const ahead = peer("honest", 100, 0)
        onlinePeers = [ahead]
        expect(await getAheadValidatorPeers()).toEqual([])
        creditVerifiedHeight(ahead, 101)
        expect((await getAheadValidatorPeers()).map(p => p.identity)).toEqual(["honest"])
    })
})

describe("getAheadValidatorPeers", () => {
    it("drops a discredited liar and keeps a peer that is really ahead", async () => {
        const liar = peer("liar", 100, 10_000)
        const honest = peer("honest", 100, 101)
        onlinePeers = [liar, honest]
        expect((await getAheadValidatorPeers()).map(p => p.identity)).toEqual(["liar", "honest"])

        discreditAdvertisedHeight(liar)
        expect((await getAheadValidatorPeers()).map(p => p.identity)).toEqual(["honest"])
    })

    it("ignores unstaked claims", async () => {
        onlinePeers = [peer("stranger", 100, 500)]
        expect(await getAheadValidatorPeers()).toEqual([])
    })
})
