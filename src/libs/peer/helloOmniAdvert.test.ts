/**
 * Peer calls move to Omni only for peers that advertised an Omni port in a
 * hello reply proven to come from the address we dialed. Nodes that predate
 * the advert, or replies that prove nothing, keep the peer on HTTP.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"
import { mockCore } from "src/utilities/testSupport/coreMocks"

const OUR_KEY = "0x" + "aa".repeat(32)
const ALICE = "0x" + "a1".repeat(32)
const GENESIS = "d5".repeat(32)
const ALICE_URL = "http://alice.example:53550"

const markPeerOmniCapable = jest.fn()
const forgetPeerOmni = jest.fn()

const sharedState: Record<string, unknown> = {
    publicKeyHex: OUR_KEY,
    signingAlgorithm: "ed25519",
    exposedUrl: "http://us.example:53550",
    lastBlockNumber: 100,
    lastBlockHash: "h100",
    syncStatus: true,
    genesisBlockHash: GENESIS,
    getConsensusTime: () => 10,
    omniAdvert: null,
    markPeerOmniCapable,
    forgetPeerOmni,
}

mockCore(sharedState)
jest.mock("src/libs/blockchain/validation/txValidatorPool", () => ({
    __esModule: true,
    default: {
        getInstance: () => ({
            verify: async () => true,
            sign: async () => ({ signature: new Uint8Array(64) }),
        }),
    },
}))
jest.mock("src/libs/peer/syncClaims", () => ({
    unknownSync: () => ({ status: false, block: null, block_hash: null }),
    corroborateSyncData: async () => ({ status: false, block: null, block_hash: null }),
}))
jest.mock("src/libs/gossip/GossipManager", () => ({
    __esModule: true,
    default: { isEnabled: () => false },
}))

const { default: PeerManager } = await import("src/libs/peer/PeerManager")
const { Peer } = await import("src/libs/peer")
const { manageHelloPeer } = await import("src/libs/network/manageHelloPeer")

function seed(identity: string, url: string) {
    const peer = new Peer(url, identity)
    peer.sync = { status: true, block: 100, block_hash: "h100" }
    peer.status = { online: true, ready: true, timestamp: Date.now() }
    PeerManager.getInstance().addPeer(peer)
}

function reply(extra: Record<string, unknown>, signed = true): any {
    return {
        result: 200,
        response: true,
        require_reply: false,
        extra: {
            msg: "Peer connected",
            ...(signed
                ? {
                      identity: ALICE,
                      url: ALICE_URL,
                      signature: { type: "ed25519", data: "cc".repeat(64) },
                  }
                : {}),
            syncData: { status: true, block: 100, block_hash: "h100" },
            genesisHash: GENESIS,
            peerlist: [],
            ...extra,
        },
    }
}

beforeEach(() => {
    const manager = PeerManager.getInstance()
    for (const peer of manager.getPeers()) manager.removeOnlinePeer(peer.identity)
    markPeerOmniCapable.mockClear()
    forgetPeerOmni.mockClear()
    sharedState.omniAdvert = null
    ;(PeerManager as any).sayHelloToPeer = async () => "unreachable"
    seed(OUR_KEY, sharedState.exposedUrl as string)
})

describe("a verified hello reply", () => {
    it("records the advertised Omni port for the dialed address", async () => {
        const { verdict } = await PeerManager.helloPeerCallback(
            reply({ omni: { port: 63551 } }),
            new Peer(ALICE_URL, ALICE),
            "nonce",
        )
        expect(verdict).toBe("verified")
        expect(markPeerOmniCapable).toHaveBeenCalledWith(ALICE, ALICE_URL, 63551)
        expect(forgetPeerOmni).not.toHaveBeenCalled()
    })

    it("without an advert (rc.7 node) keeps the peer on HTTP", async () => {
        await PeerManager.helloPeerCallback(
            reply({}),
            new Peer(ALICE_URL, ALICE),
            "nonce",
        )
        expect(markPeerOmniCapable).not.toHaveBeenCalled()
        expect(forgetPeerOmni).toHaveBeenCalledWith(ALICE)
    })

    it("with a malformed port keeps the peer on HTTP", async () => {
        await PeerManager.helloPeerCallback(
            reply({ omni: { port: "63551" } }),
            new Peer(ALICE_URL, ALICE),
            "nonce",
        )
        expect(markPeerOmniCapable).not.toHaveBeenCalled()
        expect(forgetPeerOmni).toHaveBeenCalledWith(ALICE)
    })
})

describe("an unsigned hello reply", () => {
    it("does not move a known peer to Omni", async () => {
        seed(ALICE, ALICE_URL)
        const { verdict } = await PeerManager.helloPeerCallback(
            reply({ omni: { port: 63551 } }, false),
            new Peer(ALICE_URL, ALICE),
            "nonce",
        )
        expect(verdict).toBe("unsigned")
        expect(markPeerOmniCapable).not.toHaveBeenCalled()
    })
})

describe("our hello reply", () => {
    const hello = {
        url: ALICE_URL,
        publicKey: ALICE,
        signature: { type: "ed25519", data: "cc".repeat(64) },
        syncData: { status: true, block: 100, block_hash: "h100" },
        genesisHash: GENESIS,
        nonce: "n1",
    } as any

    it("advertises our Omni port when the server runs", async () => {
        sharedState.omniAdvert = { port: 64551 }
        const response = await manageHelloPeer(hello, ALICE)
        expect(response.result).toBe(200)
        expect(response.extra.omni).toEqual({ port: 64551 })
    })

    it("advertises nothing when peers cannot reach it", async () => {
        const response = await manageHelloPeer(hello, ALICE)
        expect(response.result).toBe(200)
        expect(response.extra.omni).toBeUndefined()
    })
})
