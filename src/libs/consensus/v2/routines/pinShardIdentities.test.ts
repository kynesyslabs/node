import { describe, expect, it, jest } from "bun:test"

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

jest.mock("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getBlockByNumber: jest.fn(async () => null) },
}))

jest.mock("src/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: { getGCRValidatorsAtBlock: jest.fn(async () => []) },
}))

import { pinShardIdentities } from "./getShard"
import { PINNED_SHARD_IDENTITIES } from "src/utilities/constants"

const [PIN_A, PIN_B] = PINNED_SHARD_IDENTITIES
const peer = (identity: string) => ({ identity }) as any

describe("pinShardIdentities", () => {
    it("puts both pins first, in pin order, displacing the tail of the draw", () => {
        const shard = [
            peer("0xaa"),
            peer("0xbb"),
            peer("0xcc"),
            peer("0xdd"),
            peer("0xee"),
        ]
        const candidates = [...shard, peer(PIN_A), peer(PIN_B), peer("0xff")]
        const outcome = pinShardIdentities(shard, candidates)
        const ids = shard.map(p => p.identity)
        expect(ids).toEqual([PIN_A, PIN_B, "0xaa", "0xbb", "0xcc"])
        expect(outcome.split(",").every(o => o.endsWith("=swapped"))).toBe(
            true,
        )
    })

    it("makes the first online pin the secretary (slot 0)", () => {
        const shard = [peer("0xaa"), peer("0xbb"), peer("0xcc")]
        pinShardIdentities(shard, [...shard, peer(PIN_A), peer(PIN_B)])
        expect(shard[0].identity).toBe(PIN_A)
        expect(shard[1].identity).toBe(PIN_B)
    })

    it("falls through to the second pin when the first is offline", () => {
        const shard = [peer("0xaa"), peer("0xbb"), peer("0xcc")]
        const outcome = pinShardIdentities(shard, [...shard, peer(PIN_B)])
        const ids = shard.map(p => p.identity)
        expect(ids).toEqual([PIN_B, "0xaa", "0xbb"])
        expect(ids).not.toContain(PIN_A)
        expect(outcome).toContain(`${PIN_A.slice(0, 10)}=absent`)
    })

    it("moves already-drawn pins to the front without changing the size", () => {
        const shard = [peer("0xbb"), peer(PIN_B), peer("0xcc"), peer(PIN_A)]
        const outcome = pinShardIdentities(shard, [...shard, peer("0xdd")])
        expect(shard.map(p => p.identity)).toEqual([
            PIN_A,
            PIN_B,
            "0xbb",
            "0xcc",
        ])
        expect(outcome).toBe(
            `${PIN_A.slice(0, 10)}=drawn,${PIN_B.slice(0, 10)}=drawn`,
        )
    })

    it("leaves the shard untouched when the pins already lead the draw", () => {
        const shard = [peer(PIN_A), peer(PIN_B), peer("0xbb")]
        const before = shard.map(p => p.identity)
        pinShardIdentities(shard, [...shard, peer("0xcc")])
        expect(shard.map(p => p.identity)).toEqual(before)
    })

    it("leaves the shard untouched when no pin is a candidate", () => {
        const shard = [peer("0xaa"), peer("0xbb")]
        const before = shard.map(p => p.identity)
        const outcome = pinShardIdentities(shard, [...shard, peer("0xcc")])
        expect(shard.map(p => p.identity)).toEqual(before)
        expect(outcome).toBe(
            `${PIN_A.slice(0, 10)}=absent,${PIN_B.slice(0, 10)}=absent`,
        )
    })

    it("drops a pin that has no seat in a committee smaller than the pin count", () => {
        const shard = [peer("0xaa")]
        const outcome = pinShardIdentities(shard, [
            peer("0xaa"),
            peer(PIN_A),
            peer(PIN_B),
        ])
        expect(shard.map(p => p.identity)).toEqual([PIN_A])
        expect(outcome).toContain(`${PIN_B.slice(0, 10)}=no-slot`)
    })

    it("replaces a singleton shard with the first online pin", () => {
        const shard = [peer("0xaa")]
        pinShardIdentities(shard, [peer("0xaa"), peer(PIN_B)])
        expect(shard.map(p => p.identity)).toEqual([PIN_B])
    })

    it("is deterministic for identical inputs", () => {
        const run = () => {
            const shard = [
                peer("0xaa"),
                peer("0xbb"),
                peer("0xcc"),
                peer("0xdd"),
            ]
            pinShardIdentities(shard, [...shard, peer(PIN_A), peer(PIN_B)])
            return shard.map(p => p.identity)
        }
        expect(run()).toEqual(run())
    })

    it("matches pinned identities case-insensitively", () => {
        const shard = [peer("0xaa"), peer("0xbb")]
        const mixedCase = "0x" + PIN_A.slice(2).toUpperCase()
        pinShardIdentities(shard, [...shard, peer(mixedCase)])
        expect(shard[0].identity.toLowerCase()).toBe(PIN_A)
        expect(shard).toHaveLength(2)
    })
})
