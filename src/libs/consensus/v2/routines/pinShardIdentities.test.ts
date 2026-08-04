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
    it("swaps both pins in without touching slot 0", () => {
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
        expect(ids).toContain(PIN_A)
        expect(ids).toContain(PIN_B)
        expect(ids[0]).toBe("0xaa")
        expect(ids).toHaveLength(5)
        expect(ids[4]).toBe(PIN_A)
        expect(ids[3]).toBe(PIN_B)
        expect(outcome.split(",").every(o => o.endsWith("=swapped"))).toBe(
            true,
        )
    })

    it("skips a pin that is not among the candidates", () => {
        const shard = [peer("0xaa"), peer("0xbb"), peer("0xcc")]
        const candidates = [...shard, peer(PIN_B)]
        const outcome = pinShardIdentities(shard, candidates)
        const ids = shard.map(p => p.identity)
        expect(ids).not.toContain(PIN_A)
        expect(ids).toContain(PIN_B)
        expect(ids[0]).toBe("0xaa")
        expect(outcome).toContain("=absent")
    })

    it("leaves the shard untouched when the draw already contains the pins", () => {
        const shard = [peer(PIN_A), peer("0xbb"), peer(PIN_B)]
        const before = shard.map(p => p.identity)
        const outcome = pinShardIdentities(shard, [...shard, peer("0xcc")])
        expect(shard.map(p => p.identity)).toEqual(before)
        expect(outcome).toBe(
            `${PIN_A.slice(0, 10)}=drawn,${PIN_B.slice(0, 10)}=drawn`,
        )
    })

    it("is a no-op when every candidate is already in the shard", () => {
        const shard = [peer("0xaa"), peer(PIN_A), peer(PIN_B)]
        const before = shard.map(p => p.identity)
        pinShardIdentities(shard, [...shard])
        expect(shard.map(p => p.identity)).toEqual(before)
    })

    it("never displaces slot 0, skipping the pin instead", () => {
        const shard = [peer("0xaa"), peer(PIN_A)]
        const candidates = [...shard, peer(PIN_B)]
        const outcome = pinShardIdentities(shard, candidates)
        const ids = shard.map(p => p.identity)
        expect(ids[0]).toBe("0xaa")
        expect(ids).not.toContain(PIN_B)
        expect(outcome).toContain("=no-slot")
    })

    it("leaves a singleton shard untouched", () => {
        const shard = [peer("0xaa")]
        const outcome = pinShardIdentities(shard, [peer("0xaa"), peer(PIN_A)])
        expect(shard[0].identity).toBe("0xaa")
        expect(outcome).toContain("=no-slot")
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
        expect(
            shard.some(p => p.identity.toLowerCase() === PIN_A),
        ).toBe(true)
    })
})
