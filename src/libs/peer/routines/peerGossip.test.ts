/**
 * A node whose only contact restarted is forgotten by it and is never
 * introduced to the peers that joined later. Gossip is what reaches it again:
 * a round must notice the different list and say hello to the peers it lacks.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"

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

const sharedState: Record<string, any> = {
    publicKeyHex: "0xself",
    inPeerGossip: false,
}
jest.mock("src/utilities/sharedState", () => ({ getSharedState: sharedState }))
// setPeers places each listed key against the validator table; none staked here.
jest.mock("src/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: { getGCRValidatorsAtBlockOrThrow: async () => [] },
}))

const { default: peerManagerClass } = await import("../PeerManager")
const { default: peerClass } = await import("../Peer")
const { MAX_NEW_PEERS_PER_ROUND, peerGossip, peerlistDigest, unknownPeersFromLists } = await import("./peerGossip")

const peerman = peerManagerClass.getInstance()
const online = () => (peerman as any).peerList as Record<string, any>

const hellos: string[] = []
const sayHello = jest.spyOn(peerManagerClass, "sayHelloToPeer")

/** A listed peer that answers gossip calls with `list` as its peer list. */
function gossipPeer(
    identity: string,
    url: string,
    list: { identity: string; url: string; block?: number }[],
    rawList?: unknown,
) {
    const peer = new peerClass(url, identity)
    const calls: string[] = []
    peer.call = jest.fn(async (request: any) => {
        const message = request.params[0].message
        calls.push(message)
        if (message === "getPeerlistHash") {
            return { result: 200, response: peerlistDigest(list), require_reply: false, extra: null }
        }
        return {
            result: 200,
            response:
                rawList ??
                list.map(entry => ({
                    identity: entry.identity,
                    connection: { string: entry.url },
                    verification: {},
                    sync: { block: entry.block ?? 0, block_hash: "0xforged", status: true },
                    status: { online: true },
                })),
            require_reply: false,
            extra: null,
        }
    }) as any
    online()[identity] = peer
    return { peer, calls }
}

beforeEach(() => {
    for (const key of Object.keys(online())) delete online()[key]
    hellos.length = 0
    sharedState.inPeerGossip = false
    sayHello.mockReset()
    sayHello.mockImplementation(async (peer: any) => {
        hellos.push(peer.identity)
        return null as any
    })
})

describe("peerlistDigest", () => {
    it("depends on the identities only, not their order or sync data", () => {
        const a = peerlistDigest([{ identity: "0xb" }, { identity: "0xa" }])
        const b = peerlistDigest([{ identity: "0xa" }, { identity: "0xb" }, { identity: "0xa" }])
        expect(a).toBe(b)
        expect(peerlistDigest([{ identity: "0xa" }])).not.toBe(a)
    })
})

describe("peerGossip", () => {
    it("says hello to the peers a contact knows and this node does not", async () => {
        gossipPeer("0xself", "http://45.0.0.1:53553", [])
        const { calls } = gossipPeer("0xanchor", "http://45.0.0.2:53551", [
            { identity: "0xanchor", url: "http://45.0.0.2:53551" },
            { identity: "0xlate", url: "http://45.0.0.3:53555" },
        ])

        await peerGossip()

        expect(calls).toEqual(["getPeerlistHash", "getPeerlist"])
        expect(hellos).toEqual(["0xlate"])
    })

    it("asks no full list when the identities already match", async () => {
        gossipPeer("0xself", "http://45.0.0.1:53553", [])
        const { calls } = gossipPeer("0xanchor", "http://45.0.0.2:53551", [
            { identity: "0xanchor", url: "http://45.0.0.2:53551" },
            { identity: "0xself", url: "http://45.0.0.1:53553" },
        ])

        await peerGossip()

        expect(calls).toEqual(["getPeerlistHash"])
        expect(hellos).toEqual([])
    })

    it("never gossips with itself", async () => {
        const { calls } = gossipPeer("0xself", "http://45.0.0.1:53553", [])

        await peerGossip()

        expect(calls).toEqual([])
    })

    it("never takes sync data for a known peer from a list", async () => {
        gossipPeer("0xself", "http://45.0.0.1:53553", [])
        const { peer: known } = gossipPeer("0xknown", "http://45.0.0.4:53557", [])
        known.sync.block = 5
        known.sync.block_hash = "0xreal"
        gossipPeer("0xanchor", "http://45.0.0.2:53551", [
            { identity: "0xknown", url: "http://45.0.0.4:53557", block: 1_000_000_000 },
            { identity: "0xlate", url: "http://45.0.0.3:53555" },
        ])

        await peerGossip()

        expect(known.sync.block).toBe(5)
        expect(known.sync.block_hash).toBe("0xreal")
        expect(hellos).toEqual(["0xlate"])
    })

    it("keeps the other lists when one peer answers garbage", async () => {
        gossipPeer("0xself", "http://45.0.0.1:53553", [])
        gossipPeer("0xbad", "http://45.0.0.5:53559", [{ identity: "0xx", url: "x" }], [
            null,
            { identity: 7 },
            { identity: "0xnourl" },
        ])
        gossipPeer("0xworse", "http://45.0.0.6:53561", [{ identity: "0xy", url: "y" }], "not a list")
        gossipPeer("0xanchor", "http://45.0.0.2:53551", [
            { identity: "0xlate", url: "http://45.0.0.3:53555" },
        ])

        await peerGossip()

        expect(hellos).toEqual(["0xlate"])
    })
})

describe("unknownPeersFromLists", () => {
    it("bounds the hellos one round can cause", () => {
        const flood = Array.from({ length: 500 }, (_, i) => ({
            identity: `0xflood${i}`,
            connection: { string: `http://45.1.${Math.floor(i / 250)}.${i % 250}:53550` },
        }))
        expect(unknownPeersFromLists([flood, flood])).toHaveLength(MAX_NEW_PEERS_PER_ROUND)
    })

    it("reaches a missing peer past the first window of a long list", () => {
        // The node knows every listed peer except the last, which no fixed
        // window starting at entry 0 would ever reach.
        const long = Array.from({ length: 300 }, (_, i) => ({
            identity: `0xp${String(i).padStart(3, "0")}`,
            connection: { string: `http://45.2.${Math.floor(i / 250)}.${i % 250}:53550` },
        }))
        for (const entry of long.slice(0, 299)) {
            online()[entry.identity] = new peerClass(entry.connection.string, entry.identity)
        }
        expect(unknownPeersFromLists([long], () => 0).map(peer => peer.identity)).toEqual([])
        expect(unknownPeersFromLists([long], () => 0.9).map(peer => peer.identity)).toEqual(["0xp299"])
    })
})
