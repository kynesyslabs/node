/**
 * A standby flag in a hello reply keeps the key's URL where it is, so it
 * must be covered by the reply signature: stripping it in transit would let
 * a stopped copy take over the URL, adding it would block a real failover.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mockCore } from "src/utilities/testSupport/coreMocks"
import { mockHelloDeps } from "src/libs/peer/testSupport/helloMocks"

const OUR_KEY = "0x" + "aa".repeat(32)
const BOB = "0x" + "b0".repeat(32)
const GENESIS = "d5".repeat(32)
const OUR_URL = "http://us.example:53550"
const BOB_URL = "http://bob.example:53550"
const NONCE = "11".repeat(32)

const sharedState: Record<string, unknown> = {
    publicKeyHex: OUR_KEY,
    signingAlgorithm: "ed25519",
    exposedUrl: OUR_URL,
    lastBlockNumber: 100,
    lastBlockHash: "h100",
    syncStatus: true,
    genesisBlockHash: GENESIS,
    getConsensusTime: () => 10,
}

mockCore(sharedState)

// The "signature" is the signed message itself: verification then checks
// exactly which message was signed. Hello requests are not under test here.
const decoder = new TextDecoder()
mockHelloDeps({
    sign: async (_alg, message) => ({ signature: new Uint8Array(message) }),
    verify: async input => {
        const text = decoder.decode(input.message)
        if (!text.startsWith("DEMOS_PEER_AUTH_V1:")) return true
        return text === decoder.decode(input.signature)
    },
})

const { default: PeerManager } = await import("src/libs/peer/PeerManager")
const { Peer } = await import("src/libs/peer")
const { manageHelloPeer } = await import("src/libs/network/manageHelloPeer")
const { helloResponseMessage } = await import("src/libs/peer/helloAuth")
const { haltSigning, __resetSigningHalt } = await import(
    "src/libs/identity/signingRecord"
)

function seed(identity: string, url: string) {
    const peer = new Peer(url, identity)
    peer.sync = { status: true, block: 100, block_hash: "h100" }
    peer.status = { online: true, ready: true, timestamp: Date.now() }
    PeerManager.getInstance().addPeer(peer)
}

async function replyToBob() {
    return manageHelloPeer(
        {
            url: BOB_URL,
            publicKey: BOB,
            signature: { type: "ed25519", data: "cc".repeat(64) },
            syncData: { status: true, block: 100, block_hash: "h100" },
            genesisHash: GENESIS,
            nonce: NONCE,
        } as any,
        BOB,
    )
}

function verify(reply: any) {
    return PeerManager.verifyHelloResponse(reply, new Peer(OUR_URL, OUR_KEY), NONCE)
}

beforeEach(() => {
    const manager = PeerManager.getInstance()
    for (const peer of manager.getPeers()) manager.removeOnlinePeer(peer.identity)
    ;(PeerManager as any).sayHelloToPeer = async () => "unreachable"
    seed(OUR_KEY, OUR_URL)
    seed(BOB, BOB_URL)
})

afterEach(() => __resetSigningHalt())

describe("the standby flag in a hello reply", () => {
    it("verifies as sent by a copy that stopped signing", async () => {
        haltSigning("test: another process signs with this key")
        const reply = await replyToBob()
        expect(reply.extra.standby).toBe(true)
        expect(await verify(reply)).toBe("verified")
    })

    it("cannot be stripped in transit", async () => {
        haltSigning("test: another process signs with this key")
        const reply = await replyToBob()
        delete reply.extra.standby
        expect(await verify(reply)).toBe("invalid")
    })

    it("cannot be added in transit to a signing node's reply", async () => {
        const reply = await replyToBob()
        expect(reply.extra.standby).toBeUndefined()
        reply.extra.standby = true
        expect(await verify(reply)).toBe("invalid")
    })

    it("leaves a signing node's reply in the form older nodes verify", async () => {
        const reply = await replyToBob()
        expect(await verify(reply)).toBe("verified")
        expect(decoder.decode(helloResponseMessage(NONCE, OUR_URL))).toBe(
            `DEMOS_PEER_AUTH_V1:${NONCE}:${OUR_URL}`,
        )
    })
})
