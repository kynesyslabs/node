/**
 * A trailing dot is the absolute form of the same DNS name, so
 * us.example.:53550 is our own address. Another identity advertising it, or
 * our own address when we advertise the dotted form, must be refused like the
 * exact spelling.
 *
 * Other spellings of our address are refused too: host and scheme case,
 * percent-encoded host letters, leading zeros in the port and an explicit
 * default port are folded by the URL parser, and the same host and TCP port
 * written under the other scheme's default (https://us.example and
 * http://us.example:443) is our address as well.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mockCore } from "src/utilities/testSupport/coreMocks"
import { mockHelloDeps } from "./testSupport/helloMocks"

const OUR_KEY = "0x" + "aa".repeat(32)
const ALICE = "0x" + "a1".repeat(32)
const OUR_URL = "http://us.example:53550"
const OUR_URL_DOTTED = "http://us.example.:53550"
const POINTS_AT_US = "Connection string points at us"
const OUR_URL_HTTP = "http://us.example"
const OUR_URL_HTTPS = "https://us.example"

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

// eslint-disable-next-line @typescript-eslint/naming-convention
const { default: PeerManager } = await import("src/libs/peer/PeerManager")
// eslint-disable-next-line @typescript-eslint/naming-convention
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

describe("other spellings of our address", () => {
    it("upper- and mixed-case host is refused for another identity", () => {
        expectRefused(ALICE, "http://US.EXAMPLE:53550")
        expectRefused(ALICE, "http://US.Example:53550")
    })

    it("upper-case scheme is refused for another identity", () => {
        expectRefused(ALICE, "HTTP://us.example:53550")
    })

    it("mixed case with a trailing dot is refused for another identity", () => {
        expectRefused(ALICE, "http://Us.Example.:53550")
    })

    it("several trailing dots are refused for another identity", () => {
        expectRefused(ALICE, "http://us.example..:53550")
    })

    it("a percent-encoded host letter is refused for another identity", () => {
        expectRefused(ALICE, "http://%75s.example:53550")
    })

    it("a leading zero in the port is refused for another identity", () => {
        expectRefused(ALICE, "http://us.example:053550")
    })

    it("an explicit http default port is refused when we advertise none", () => {
        sharedState.exposedUrl = OUR_URL_HTTP
        expectRefused(ALICE, "http://us.example:80")
    })

    it("an explicit https default port is refused when we advertise none", () => {
        sharedState.exposedUrl = OUR_URL_HTTPS
        expectRefused(ALICE, "https://us.example:443")
    })

    it("no port is refused when we advertise the explicit http default", () => {
        sharedState.exposedUrl = "http://us.example:80"
        expectRefused(ALICE, OUR_URL_HTTP)
    })
})

describe("our host and TCP port under the other scheme's default port", () => {
    it("http on 443 is refused when we advertise https", () => {
        sharedState.exposedUrl = OUR_URL_HTTPS
        expectRefused(ALICE, "http://us.example:443")
    })

    it("https is refused when we advertise http on 443", () => {
        sharedState.exposedUrl = "http://us.example:443"
        expectRefused(ALICE, OUR_URL_HTTPS)
    })

    it("https on 80 is refused when we advertise http", () => {
        sharedState.exposedUrl = OUR_URL_HTTP
        expectRefused(ALICE, "https://us.example:80")
    })

    it("http is refused when we advertise https on 80", () => {
        sharedState.exposedUrl = "https://us.example:80"
        expectRefused(ALICE, OUR_URL_HTTP)
    })
})

describe("other spellings that are not ours", () => {
    it("another host in upper case is accepted", () => {
        const peer = new Peer("http://ALICE.Example:53550", ALICE)
        expect(PeerManager.getInstance().canAddPeer(peer)).toEqual([true, ""])
    })

    it("our host on http 8443 is accepted when we advertise https", () => {
        sharedState.exposedUrl = OUR_URL_HTTPS
        const peer = new Peer("http://us.example:8443", ALICE)
        expect(PeerManager.getInstance().canAddPeer(peer)).toEqual([true, ""])
    })

    it("our host over https is accepted when we advertise port 53550", () => {
        const peer = new Peer(OUR_URL_HTTPS, ALICE)
        expect(PeerManager.getInstance().canAddPeer(peer)).toEqual([true, ""])
    })
})
