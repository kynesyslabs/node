/**
 * Peer calls move to Omni only for peers that advertised an Omni port in a
 * hello reply proven to come from the address we dialed, with the port
 * itself signed. Nodes that predate the advert, or replies that prove
 * nothing, keep the peer on HTTP.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"
import { mockCore } from "src/utilities/testSupport/coreMocks"
import { mockHelloDeps } from "./testSupport/helloMocks"
import { helloOmniAdvertMessage, helloResponseMessage } from "./helloAuth"

const OUR_KEY = "0x" + "aa".repeat(32)
const ALICE = "0x" + "a1".repeat(32)
const GENESIS = "d5".repeat(32)
const ALICE_URL = "http://alice.example:53550"
const NONCE = "nonce"

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

// A stand-in scheme: a signature is the message it signs, so a reply
// verifies only if what it carries is exactly what was signed.
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex")
mockCore(sharedState)
mockHelloDeps({
    verify: async ({ message, signature }) =>
        hex(message) === hex(signature),
    sign: async (_algorithm, message) => ({ signature: message }),
})

const { default: PeerManager } = await import("src/libs/peer/PeerManager")
const { Peer } = await import("src/libs/peer")
const { manageHelloPeer } = await import("src/libs/network/manageHelloPeer")

const fromAlice = (response: any) =>
    PeerManager.helloPeerCallback(response, new Peer(ALICE_URL, ALICE), NONCE)

function seed(identity: string, url: string) {
    const peer = new Peer(url, identity)
    peer.sync = { status: true, block: 100, block_hash: "h100" }
    peer.status = { online: true, ready: true, timestamp: Date.now() }
    PeerManager.getInstance().addPeer(peer)
}

/** An Omni advert for `port`, its signature made over `signedPort`. */
function advert(port: unknown, signedPort = port as number) {
    return {
        port,
        signature: {
            type: "ed25519",
            data: hex(helloOmniAdvertMessage(NONCE, ALICE_URL, signedPort)),
        },
    }
}

function reply(extra: Record<string, unknown>, signed = true): any {
    const proof = {
        identity: ALICE,
        url: ALICE_URL,
        signature: {
            type: "ed25519",
            data: hex(helloResponseMessage(NONCE, ALICE_URL)),
        },
    }
    return {
        result: 200,
        response: true,
        require_reply: false,
        extra: {
            msg: "Peer connected",
            ...(signed ? proof : {}),
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
    it("records the signed Omni port for the dialed address", async () => {
        const { verdict } = await fromAlice(reply({ omni: advert(63551) }))
        expect(verdict).toBe("verified")
        expect(markPeerOmniCapable).toHaveBeenCalledWith(ALICE, ALICE_URL, 63551)
        expect(forgetPeerOmni).not.toHaveBeenCalled()
    })

    it("with a port the signature does not cover keeps the peer on HTTP", async () => {
        const { verdict } = await fromAlice(reply({ omni: advert(63552, 63551) }))
        expect(verdict).toBe("verified")
        expect(markPeerOmniCapable).not.toHaveBeenCalled()
        expect(forgetPeerOmni).toHaveBeenCalledWith(ALICE)
    })

    it("with an unsigned port keeps the peer on HTTP", async () => {
        await fromAlice(reply({ omni: { port: 63551 } }))
        expect(markPeerOmniCapable).not.toHaveBeenCalled()
        expect(forgetPeerOmni).toHaveBeenCalledWith(ALICE)
    })

    it("without an advert (rc.7 node) keeps the peer on HTTP", async () => {
        await fromAlice(reply({}))
        expect(markPeerOmniCapable).not.toHaveBeenCalled()
        expect(forgetPeerOmni).toHaveBeenCalledWith(ALICE)
    })

    it("with a malformed port keeps the peer on HTTP", async () => {
        await fromAlice(reply({ omni: advert("63551", 63551) }))
        expect(markPeerOmniCapable).not.toHaveBeenCalled()
        expect(forgetPeerOmni).toHaveBeenCalledWith(ALICE)
    })
})

describe("an unsigned hello reply", () => {
    it("does not move a known peer to Omni", async () => {
        seed(ALICE, ALICE_URL)
        const { verdict } = await fromAlice(reply({ omni: advert(63551) }, false))
        expect(verdict).toBe("unsigned")
        expect(markPeerOmniCapable).not.toHaveBeenCalled()
    })
})

describe("our hello reply", () => {
    const hello = {
        url: ALICE_URL,
        publicKey: ALICE,
        signature: {
            type: "ed25519",
            data: hex(new TextEncoder().encode(ALICE_URL)),
        },
        syncData: { status: true, block: 100, block_hash: "h100" },
        genesisHash: GENESIS,
        nonce: "n1",
    } as any

    it("advertises our Omni port, signed over the caller's nonce and our URL", async () => {
        sharedState.omniAdvert = { port: 64551 }
        const response = await manageHelloPeer(hello, ALICE)
        expect(response.result).toBe(200)
        expect(response.extra.omni.port).toBe(64551)
        const signed = helloOmniAdvertMessage(
            "n1",
            sharedState.exposedUrl as string,
            64551,
        )
        expect(response.extra.omni.signature.data).toBe("0x" + hex(signed))
    })

    it("advertises nothing when peers cannot reach it", async () => {
        const response = await manageHelloPeer(hello, ALICE)
        expect(response.result).toBe(200)
        expect(response.extra.omni).toBeUndefined()
    })
})

describe("a hello that timed out", () => {
    const timedOut = (extra: Record<string, unknown>): any => ({
        result: 504,
        response: "Request timeout",
        require_reply: false,
        extra,
    })

    it("takes the peer offline after a full budget", async () => {
        const markPeerOffline = jest.spyOn(PeerManager, "markPeerOffline")
        await fromAlice(timedOut({ code: "ETIMEDOUT" }))
        expect(markPeerOffline).toHaveBeenCalledTimes(1)
        markPeerOffline.mockRestore()
    })

    it("does not when a failed Omni connect cut its budget short", async () => {
        const markPeerOffline = jest.spyOn(PeerManager, "markPeerOffline")
        await fromAlice(timedOut({ code: "ETIMEDOUT", inconclusive: true }))
        expect(markPeerOffline).not.toHaveBeenCalled()
        markPeerOffline.mockRestore()
    })
})
