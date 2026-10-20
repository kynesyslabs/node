/**
 * A hello is answered only by a node that knows its own block 0, and only a
 * caller that reports the same block 0 gets into the peerlist. Callers from
 * another network are dropped; callers that report none are old nodes and
 * are left out until they upgrade.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"

const OUR_KEY = "aa".repeat(32)
const CALLER = "bb".repeat(32)
const GENESIS = "d5".repeat(32)

const sharedState: Record<string, unknown> = {
    publicKeyHex: OUR_KEY,
    signingAlgorithm: "ed25519",
    exposedUrl: "http://us:53550",
    lastBlockNumber: 0,
    genesisBlockHash: GENESIS,
}
const removed: string[] = []
const added: string[] = []
let known: unknown = null

class FakePeer {
    identity = ""
    connection = { string: "" }
    verification = { status: false }
    status = { ready: false, online: false, timestamp: 0 }
    sync: unknown = null
}
const peerManager = {
    getPeer: () => known,
    removeOnlinePeer: (id: string) => removed.push(id),
    removeOfflinePeer: () => undefined,
    addPeer: (p: FakePeer) => {
        added.push(p.identity)
        return [true, ""]
    },
    canAddPeer: () => [true, ""],
    getPeers: () => [],
    ourSyncData: { status: true, block: 0, block_hash: GENESIS },
}

jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn() },
}))
jest.mock("src/utilities/sharedState", () => ({ getSharedState: sharedState }))
jest.mock("@/utilities/waiter", () => ({ Waiter: { resolve: jest.fn(), isWaiting: () => false, keys: {} } }))
jest.mock("../peer", () => ({
    Peer: FakePeer,
    PeerManager: { getInstance: () => peerManager, verifying: new Set(), sayHelloToPeer: async () => undefined },
}))
jest.mock("./server_rpc", () => ({ emptyResponse: { result: 0, response: null, require_reply: false, extra: {} } }))
jest.mock("@kynesyslabs/demosdk/encryption", () => ({
    hexToUint8Array: (hex: string) => new Uint8Array(Buffer.from(hex, "hex")),
    uint8ArrayToHex: (b: Uint8Array) => Buffer.from(b).toString("hex"),
    ucrypto: {},
}))
jest.mock("../blockchain/validation/txValidatorPool", () => ({
    __esModule: true,
    default: { getInstance: () => ({ verify: async () => true, sign: async () => ({ signature: new Uint8Array(64) }) }) },
}))
jest.mock("../peer/helloAuth", () => ({ helloResponseMessage: () => new Uint8Array(1) }))
jest.mock("../gossip/GossipManager", () => ({ __esModule: true, default: { isEnabled: () => false } }))
jest.mock("src/config", () => ({ parseNodeUrl: (u: string) => ({ origin: u }) }))
jest.mock("../peer/identityLiveness", () => ({ reportTwin: jest.fn() }))
jest.mock("../peer/syncClaims", () => ({
    corroborateSyncData: async () => ({ status: false, block: null, block_hash: null }),
}))

const { manageHelloPeer } = await import("./manageHelloPeer")

function hello(genesisHash?: string): any {
    return {
        url: "http://caller:53550",
        publicKey: CALLER,
        signature: { type: "ed25519", data: "cc".repeat(64) },
        syncData: { status: true, block: 529479, block_hash: "old" },
        ...(genesisHash ? { genesisHash } : {}),
    }
}

beforeEach(() => {
    sharedState.genesisBlockHash = GENESIS
    removed.length = 0
    added.length = 0
    known = null
})

describe("hello genesis gate", () => {
    it("tells callers to retry until our block 0 is loaded", async () => {
        sharedState.genesisBlockHash = null
        const reply = await manageHelloPeer(hello(GENESIS), CALLER)
        expect(reply.result).toBe(503)
        expect(added).toEqual([])
    })

    it("refuses and drops a caller from another network", async () => {
        known = { status: { online: true }, connection: { string: "http://caller:53550" } }
        const reply = await manageHelloPeer(hello("83".repeat(32)), CALLER)
        expect(reply.result).toBe(409)
        expect(reply.extra.genesisHash).toBe(GENESIS)
        expect(removed).toEqual([CALLER])
        expect(added).toEqual([])
    })

    it("leaves out a caller that reports no genesis hash", async () => {
        const reply = await manageHelloPeer(hello(), CALLER)
        expect(reply.result).toBe(426)
        expect(added).toEqual([])
    })

    it("accepts a caller on our network and answers with our hash", async () => {
        known = { status: { online: true }, connection: { string: "http://caller:53550" } }
        const reply = await manageHelloPeer(hello(GENESIS), CALLER)
        expect(reply.result).toBe(200)
        expect(reply.extra.genesisHash).toBe(GENESIS)
        expect(added).toEqual([CALLER])
    })
})
