/**
 * A peer's entry may only be changed by that peer. A hello or heights record
 * signed by A that names B's address is A's word, not proof that A serves
 * it: it must not evict B. Only a hello reply from the address, signed over
 * our nonce by the key we dialed, moves a binding.
 */

import { beforeEach, describe, expect, it } from "bun:test"
import { mockCore } from "src/utilities/testSupport/coreMocks"
import { mockHelloDeps } from "./testSupport/helloMocks"

const OUR_KEY = "0x" + "aa".repeat(32)
const ALICE = "0x" + "a1".repeat(32)
const BOB = "0x" + "b0".repeat(32)
const GENESIS = "d5".repeat(32)
const ALICE_URL = "http://alice.example:53550"
const BOB_URL = "http://bob.example:53550"

const sharedState: Record<string, unknown> = {
    publicKeyHex: OUR_KEY,
    signingAlgorithm: "ed25519",
    exposedUrl: "http://us.example:53550",
    lastBlockNumber: 100,
    lastBlockHash: "h100",
    syncStatus: true,
    genesisBlockHash: GENESIS,
    getConsensusTime: () => 10,
    markPeerOmniCapable: () => {},
    forgetPeerOmni: () => {},
}

mockCore(sharedState)
mockHelloDeps()

const { default: PeerManager } = await import("src/libs/peer/PeerManager")
const { Peer } = await import("src/libs/peer")
const { manageHelloPeer } = await import("src/libs/network/manageHelloPeer")

const hellos: { identity: string; url: string }[] = []

function seed(identity: string, url: string) {
    const peer = new Peer(url, identity)
    peer.sync = { status: true, block: 100, block_hash: "h100" }
    peer.status = { online: true, ready: true, timestamp: Date.now() }
    PeerManager.getInstance().addPeer(peer)
}

function helloFrom(identity: string, url: string): any {
    return {
        url,
        publicKey: identity,
        signature: { type: "ed25519", data: "cc".repeat(64) },
        syncData: { status: true, block: 100, block_hash: "h100" },
        genesisHash: GENESIS,
    }
}

beforeEach(() => {
    const manager = PeerManager.getInstance()
    for (const peer of manager.getPeers()) manager.removeOnlinePeer(peer.identity)
    for (const identity of Object.keys(manager.getOfflinePeers())) {
        manager.removeOfflinePeer(identity)
    }
    hellos.length = 0
    ;(PeerManager as any).sayHelloToPeer = async (peer: InstanceType<typeof Peer>) => {
        hellos.push({ identity: peer.identity, url: peer.connection.string })
        return "unreachable"
    }
    seed(OUR_KEY, sharedState.exposedUrl as string)
    seed(ALICE, ALICE_URL)
    seed(BOB, BOB_URL)
})

describe("a signed claim to another validator's address", () => {
    it("does not evict that validator or move the claimant", async () => {
        const reply = await manageHelloPeer(helloFrom(ALICE, BOB_URL), ALICE)

        const manager = PeerManager.getInstance()
        expect(reply.result).not.toBe(200)
        expect(manager.getPeer(BOB)?.connection.string).toBe(BOB_URL)
        expect(manager.getPeer(ALICE)?.connection.string).toBe(ALICE_URL)
    })

    it("is checked by dialing the address for the claimant's key", async () => {
        await manageHelloPeer(helloFrom(ALICE, BOB_URL), ALICE)
        expect(hellos).toEqual([{ identity: ALICE, url: BOB_URL }])
    })

    it("from a heights-style signed update does not evict either", () => {
        const manager = PeerManager.getInstance()
        const [ok] = manager.addPeer(new Peer(BOB_URL, ALICE), true)
        expect(ok).toBe(false)
        expect(manager.getPeer(BOB)?.connection.string).toBe(BOB_URL)
        expect(manager.getPeer(ALICE)?.connection.string).toBe(ALICE_URL)
    })

    it("still lets a peer move to a free address with its own signed hello", async () => {
        const reply = await manageHelloPeer(
            helloFrom(ALICE, "http://alice-new.example:53550"),
            ALICE,
        )
        expect(reply.result).toBe(200)
        expect(PeerManager.getInstance().getPeer(ALICE)?.connection.string).toBe(
            "http://alice-new.example:53550",
        )
    })
})

describe("a hello reply proven at the address", () => {
    it("moves the binding and drops the stale one", () => {
        const manager = PeerManager.getInstance()
        const [ok] = manager.addPeer(new Peer(BOB_URL, ALICE), true, true)
        expect(ok).toBe(true)
        expect(manager.getPeer(ALICE)?.connection.string).toBe(BOB_URL)
        expect(manager.getPeer(BOB)).toBeUndefined()
    })
})

describe("a copy of a key that stopped signing", () => {
    const ALICE_COPY_URL = "http://alice-copy.example:53550"

    function signedReply(identity: string, url: string, standby: boolean) {
        return {
            result: 200,
            response: true,
            require_reply: false,
            extra: {
                msg: "Peer connected",
                identity,
                url,
                signature: { type: "ed25519", data: "cc".repeat(64) },
                genesisHash: GENESIS,
                ...(standby ? { standby: true } : {}),
            },
        } as any
    }

    it("does not take over the key's URL with its hello", async () => {
        const reply = await manageHelloPeer(
            { ...helloFrom(ALICE, ALICE_COPY_URL), standby: true },
            ALICE,
        )
        expect(reply.result).toBe(200)
        expect(PeerManager.getInstance().getPeer(ALICE)?.connection.string).toBe(
            ALICE_URL,
        )
    })

    it("does not take over the key's URL with a proven hello reply", async () => {
        const { verdict } = await PeerManager.helloPeerCallback(
            signedReply(ALICE, ALICE_COPY_URL, true),
            new Peer(ALICE_COPY_URL, ALICE),
            "nonce",
        )
        expect(verdict).toBe("verified")
        expect(PeerManager.getInstance().getPeer(ALICE)?.connection.string).toBe(
            ALICE_URL,
        )
    })

    it("does not take over the URL of a signing copy listed offline", async () => {
        const manager = PeerManager.getInstance()
        PeerManager.markPeerOffline(manager.getPeer(ALICE)!)
        expect(manager.getPeer(ALICE)).toBeUndefined()

        await manageHelloPeer(
            { ...helloFrom(ALICE, ALICE_COPY_URL), standby: true },
            ALICE,
        )
        await PeerManager.helloPeerCallback(
            signedReply(ALICE, ALICE_COPY_URL, true),
            new Peer(ALICE_COPY_URL, ALICE),
            "nonce",
        )

        expect(manager.getPeer(ALICE)).toBeUndefined()
        expect(manager.getOfflinePeers()[ALICE]?.connection.string).toBe(ALICE_URL)
        expect(hellos).toEqual([])
    })

    it("is still added when its key is not known yet", async () => {
        const CAROL = "0x" + "c0".repeat(32)
        const CAROL_URL = "http://carol.example:53550"
        await PeerManager.helloPeerCallback(
            signedReply(CAROL, CAROL_URL, true),
            new Peer(CAROL_URL, CAROL),
            "nonce",
        )
        expect(PeerManager.getInstance().getPeer(CAROL)?.connection.string).toBe(
            CAROL_URL,
        )
    })

    it("leaves a failover to a copy that signs untouched", async () => {
        await PeerManager.helloPeerCallback(
            signedReply(ALICE, ALICE_COPY_URL, false),
            new Peer(ALICE_COPY_URL, ALICE),
            "nonce",
        )
        expect(PeerManager.getInstance().getPeer(ALICE)?.connection.string).toBe(
            ALICE_COPY_URL,
        )
    })

    it("says so in its own hello and hello replies", async () => {
        const { haltSigning, __resetSigningHalt } = await import(
            "src/libs/identity/signingRecord"
        )
        try {
            expect((await PeerManager.buildHelloRequest()).request.standby).toBeUndefined()
            haltSigning("test: another process signs with this key")
            expect((await PeerManager.buildHelloRequest()).request.standby).toBe(
                true,
            )
            const reply = await manageHelloPeer(helloFrom(BOB, BOB_URL), BOB)
            expect(reply.extra.standby).toBe(true)
        } finally {
            __resetSigningHalt()
        }
    })
})
