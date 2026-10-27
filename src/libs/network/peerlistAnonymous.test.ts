/**
 * The peerlist call needs no auth, so what it can change must not matter to
 * consensus: it teaches us addresses to verify, and never writes sync or
 * status for a peer we already track.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"

const OUR_KEY = "0x" + "aa".repeat(32)
const VALIDATOR = "0x" + "bb".repeat(32)
const STRANGER = "0x" + "cc".repeat(32)

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
        ])

        const after = PeerManager.getInstance().getPeer(VALIDATOR)
        expect(after.sync.block).toBe(100)
        expect(after.sync.block_hash).toBe("h100")
        expect(after.status.timestamp).toBe(before)
        expect(await isNetworkAhead("test")).toBe(false)
    })

    it("still learns the address of an unknown peer, and verifies it with a hello", async () => {
        knownValidator()

        const result = await ServerHandlers.handlePeerlist([
            {
                identity: STRANGER,
                connection: { string: "http://stranger.example:53550" },
                sync: { status: true, block: 9_000_000, block_hash: "forged" },
            },
        ])

        expect(result.response).toBe(true)
        expect(hellos.map(p => [p.identity, p.connection.string])).toEqual([
            [STRANGER, "http://stranger.example:53550"],
        ])
        expect(hellos[0].sync.block).toBeNull()
        expect(PeerManager.getInstance().getPeer(STRANGER)).toBeUndefined()
    })

    it("ignores malformed entries and non-list bodies", async () => {
        knownValidator()

        const bad = await ServerHandlers.handlePeerlist({ data: [] })
        await ServerHandlers.handlePeerlist([null, 5, { identity: 1 }, { identity: STRANGER }])

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
