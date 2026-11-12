/**
 * A trailing dot is the absolute form of the same DNS name, so
 * us.example.:53550 is our own address. Another identity advertising it, or
 * our own address when we advertise the dotted form, must be refused like the
 * exact spelling.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mockCore } from "src/utilities/testSupport/coreMocks"
import { mockHelloDeps } from "./testSupport/helloMocks"

const OUR_KEY = "0x" + "aa".repeat(32)
const ALICE = "0x" + "a1".repeat(32)
const OUR_URL = "http://us.example:53550"
const OUR_URL_DOTTED = "http://us.example.:53550"
const POINTS_AT_US = "Connection string points at us"

const sharedState: Record<string, unknown> = {
    publicKeyHex: OUR_KEY,
    signingAlgorithm: "ed25519",
    exposedUrl: OUR_URL,
    // Off so the loopback branch of urlPointsAtUs plays no part here.
    prod: false,
    lastBlockNumber: 100,
    lastBlockHash: "h100",
    syncStatus: true,
    genesisBlockHash: "d5".repeat(32),
    getConsensusTime: () => 10,
    markPeerOmniCapable: () => {},
    forgetPeerOmni: () => {},
}

mockCore(sharedState)
mockHelloDeps()

const { default: PeerManager } = await import("src/libs/peer/PeerManager")
const { Peer } = await import("src/libs/peer")

function clearTable() {
    const manager = PeerManager.getInstance()
    for (const peer of manager.getPeers()) manager.removeOnlinePeer(peer.identity)
    for (const identity of Object.keys(manager.getOfflinePeers())) {
        manager.removeOfflinePeer(identity)
    }
}

function expectRefused(identity: string, url: string) {
    const manager = PeerManager.getInstance()
    expect(manager.canAddPeer(new Peer(url, identity))).toEqual([false, POINTS_AT_US])
    const [ok, reason] = manager.addPeer(new Peer(url, identity))
    expect(ok).toBe(false)
    expect(reason.startsWith("Invalid connection string: ")).toBe(true)
    expect(manager.getPeer(identity)).toBeUndefined()
    expect(manager.getOfflinePeers()[identity]).toBeUndefined()
}

beforeEach(() => {
    clearTable()
})

afterEach(() => {
    sharedState.exposedUrl = OUR_URL
    clearTable()
})

describe("our address written with a trailing dot", () => {
    it("is refused for another identity", () => {
        expectRefused(ALICE, OUR_URL_DOTTED)
    })

    it("still matches when we advertise the dotted form", () => {
        sharedState.exposedUrl = OUR_URL_DOTTED
        expectRefused(ALICE, OUR_URL)
    })
})

describe("addresses that are not ours", () => {
    it("our exact address is refused for another identity", () => {
        expectRefused(ALICE, OUR_URL)
    })

    it("another host with a trailing dot is accepted", () => {
        const peer = new Peer("http://alice.example.:53550", ALICE)
        expect(PeerManager.getInstance().canAddPeer(peer)).toEqual([true, ""])
    })

    it("our host on another port is accepted", () => {
        const manager = PeerManager.getInstance()
        expect(
            manager.canAddPeer(new Peer("http://us.example:53551", ALICE)),
        ).toEqual([true, ""])
        const [ok] = manager.addPeer(new Peer("http://us.example:53551", ALICE))
        expect(ok).toBe(true)
        expect(manager.getPeer(ALICE)?.connection.string).toBe(
            "http://us.example:53551",
        )
    })

    it("our own identity at our own address is accepted", () => {
        const manager = PeerManager.getInstance()
        expect(manager.canAddPeer(new Peer(OUR_URL, OUR_KEY))).toEqual([true, ""])
        const [ok] = manager.addPeer(new Peer(OUR_URL, OUR_KEY))
        expect(ok).toBe(true)
        expect(manager.getPeer(OUR_KEY)?.connection.string).toBe(OUR_URL)
    })
})
