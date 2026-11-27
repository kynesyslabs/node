/**
 * A peerlist call teaches us addresses to verify, and never writes sync or
 * status for a peer we already track. It is served to validators. A peer in
 * the offline list and a staked validator are verified at the address this
 * node holds for them, not at the listed one.
 */

import { beforeEach, describe, expect, it, jest, mock } from "bun:test"

const OUR_KEY = "0x" + "aa".repeat(32)
const VALIDATOR = "0x" + "bb".repeat(32)
const STRANGER = "0x" + "cc".repeat(32)
const UNSEEN_VALIDATOR = "0x" + "dd".repeat(32)
const OFFLINE_PEER = "0x" + "ee".repeat(32)
const LISTED_URL = "http://listed.example:53550"

const sharedState: Record<string, unknown> = {
    publicKeyHex: OUR_KEY,
    lastBlockNumber: 100,
    lastBlockHash: "h100",
    syncStatus: true,
    getConsensusTime: () => 10,
}

jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
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
jest.mock("src/libs/consensus/stakedSet", () => ({
    getStakedSet: async () => new Set([VALIDATOR]),
    getStakedSetHeight: () => 0,
    isStaked: async () => true,
    isSelfStaked: async () => false,
    onSelfStakeChange: () => () => undefined,
    invalidateStakedSet: () => undefined,
    __resetStakedSet: () => undefined,
}))
// The validator table at the head: a staked key and the address committed
// with its stake, if any.
const validators: { address: string; connection_url: string | null }[] = []
mock.module("src/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: { getGCRValidatorsAtBlockOrThrow: async () => validators },
}))

const { default: PeerManager } = await import("src/libs/peer/PeerManager")
const { Peer } = await import("src/libs/peer")
const { default: ServerHandlers } = await import("./endpointHandlers")
const { isNetworkAhead, clearDiscreditedHeights } = await import(
    "src/libs/consensus/v2/routines/networkAheadVeto"
)

const hellos: InstanceType<typeof Peer>[] = []

function knownValidator() {
    const manager = PeerManager.getInstance()
    for (const peer of manager.getPeers()) manager.removeOnlinePeer(peer.identity)
    const peer = new Peer("http://validator.example:53550", VALIDATOR)
    peer.sync = { status: true, block: 100, block_hash: "h100" }
    peer.status = { online: true, ready: true, timestamp: Date.now() }
    manager.addPeer(peer)
    return manager.getPeer(VALIDATOR)
}

beforeEach(() => {
    hellos.length = 0
    validators.length = 0
    validators.push({
        address: VALIDATOR,
        connection_url: "http://validator.example:53550",
    })
    const manager = PeerManager.getInstance()
    for (const identity of Object.keys(manager.getOfflinePeers())) {
        manager.removeOfflinePeer(identity)
    }
    clearDiscreditedHeights()
    ;(PeerManager as any).sayHelloToPeer = async (peer: InstanceType<typeof Peer>) => {
        hellos.push(peer)
        return "unreachable"
    }
})

describe("anonymous peerlist", () => {
    it("does not move a known validator's height, so the network is not ahead", async () => {
        const known = knownValidator()
        const before = known.status.timestamp

        await ServerHandlers.handlePeerlist([
            {
                identity: VALIDATOR,
                connection: { string: "http://validator.example:53550" },
                sync: { status: true, block: 9_000_000, block_hash: "forged" },
                status: { online: true, ready: true, timestamp: Date.now() + 10 * 365 * 24 * 3600 * 1000 },
            },
        ], VALIDATOR)

        const after = PeerManager.getInstance().getPeer(VALIDATOR)
        expect(after.sync.block).toBe(100)
        expect(after.sync.block_hash).toBe("h100")
        expect(after.status.timestamp).toBe(before)
        expect(await isNetworkAhead("test")).toBe(false)
    })

    it("learns the address of an unknown peer from a validator, and verifies it with a hello", async () => {
        knownValidator()

        const result = await ServerHandlers.handlePeerlist([
            {
                identity: STRANGER,
                connection: { string: "http://stranger.example:53550" },
                sync: { status: true, block: 9_000_000, block_hash: "forged" },
            },
        ], VALIDATOR)

        expect(result.response).toBe(true)
        expect(hellos.map(p => [p.identity, p.connection.string])).toEqual([
            [STRANGER, "http://stranger.example:53550"],
        ])
        expect(hellos[0].sync.block).toBeNull()
        expect(PeerManager.getInstance().getPeer(STRANGER)).toBeUndefined()
    })

    it("verifies no more than two unknown peers a list names at one address", async () => {
        knownValidator()
        const unknown = (n: number) => "0x" + n.toString(16).padStart(64, "0")

        await ServerHandlers.handlePeerlist(
            [1, 2, 3, 4].map(n => ({
                identity: unknown(n),
                connection: { string: LISTED_URL },
            })),
            VALIDATOR,
        )

        expect(hellos.map(p => [p.identity, p.connection.string])).toEqual([
            [unknown(1), LISTED_URL],
            [unknown(2), LISTED_URL],
        ])
    })

    it("verifies a staked validator it has not seen at the address committed with its stake", async () => {
        knownValidator()
        validators.push({
            address: UNSEEN_VALIDATOR,
            connection_url: "http://unseen.example:53550",
        })

        await ServerHandlers.handlePeerlist([
            { identity: UNSEEN_VALIDATOR, connection: { string: LISTED_URL } },
        ], VALIDATOR)

        expect(hellos.map(p => [p.identity, p.connection.string])).toEqual([
            [UNSEEN_VALIDATOR, "http://unseen.example:53550"],
        ])
    })

    it("starts no hello for a staked validator without a committed address", async () => {
        knownValidator()
        validators.push({ address: UNSEEN_VALIDATOR, connection_url: null })

        const result = await ServerHandlers.handlePeerlist([
            { identity: UNSEEN_VALIDATOR, connection: { string: LISTED_URL } },
        ], VALIDATOR)

        expect(result.response).toBe(true)
        expect(hellos).toHaveLength(0)
    })

    it("verifies a peer in the offline list at its stored address", async () => {
        knownValidator()
        PeerManager.getInstance().addOfflinePeer(
            new Peer("http://offline.example:53550", OFFLINE_PEER),
        )

        await ServerHandlers.handlePeerlist([
            { identity: OFFLINE_PEER, connection: { string: LISTED_URL } },
        ], VALIDATOR)

        expect(hellos.map(p => [p.identity, p.connection.string])).toEqual([
            [OFFLINE_PEER, "http://offline.example:53550"],
        ])
    })

    it("starts no hello for a caller that is not a validator", async () => {
        knownValidator()

        const result = await ServerHandlers.handlePeerlist([
            { identity: STRANGER, connection: { string: "http://stranger.example:53550" } },
        ])

        expect(result.response).toBe(false)
        expect(result.extra.peerlistState).toBe("rejected")
        expect(hellos).toHaveLength(0)
    })

    it("ignores malformed entries and non-list bodies", async () => {
        knownValidator()

        const bad = await ServerHandlers.handlePeerlist({ data: [] }, VALIDATOR)
        await ServerHandlers.handlePeerlist([null, 5, { identity: 1 }, { identity: STRANGER }], VALIDATOR)

        expect(bad.response).toBe(false)
        expect(hellos).toHaveLength(0)
    })
})

describe("addPeer", () => {
    it("never records a status timestamp ahead of our clock", () => {
        const manager = PeerManager.getInstance()
        const peer = new Peer("http://other.example:53550", "0x" + "dd".repeat(32))
        peer.status = { online: true, ready: true, timestamp: Date.now() + 3600_000 }

        manager.addPeer(peer)

        expect(manager.getPeer(peer.identity).status.timestamp).toBeLessThanOrEqual(Date.now())
        manager.removeOnlinePeer(peer.identity)
    })

    it("lets the peer's own signed hello lower its corroborated height", () => {
        const manager = PeerManager.getInstance()
        knownValidator()
        manager.getPeer(VALIDATOR).sync = { status: true, block: 100, block_hash: "h100" }

        const rollback = new Peer("http://validator.example:53550", VALIDATOR)
        rollback.sync = { status: true, block: 90, block_hash: "h90" }
        rollback.status = { online: true, ready: true, timestamp: Date.now() }

        manager.addPeer(rollback, true)

        expect(manager.getPeer(VALIDATOR).sync.block).toBe(90)
    })

    it("does not lower the height for an update the peer did not sign", () => {
        const manager = PeerManager.getInstance()
        knownValidator()

        const lower = new Peer("http://validator.example:53550", VALIDATOR)
        lower.sync = { status: true, block: 90, block_hash: "h90" }
        lower.status = { online: true, ready: true, timestamp: Date.now() }

        manager.addPeer(lower)

        expect(manager.getPeer(VALIDATOR).sync.block).toBe(100)
    })
})
