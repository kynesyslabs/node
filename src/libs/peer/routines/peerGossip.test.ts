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

const { default: peerManagerClass } = await import("../PeerManager")
const { default: peerClass } = await import("../Peer")
const { peerGossip, peerlistDigest } = await import("./peerGossip")

const peerman = peerManagerClass.getInstance()
const online = () => (peerman as any).peerList as Record<string, any>

const hellos: string[] = []
const sayHello = jest.spyOn(peerManagerClass, "sayHelloToPeer")

/** A listed peer that answers gossip calls with `list` as its peer list. */
function gossipPeer(identity: string, url: string, list: { identity: string; url: string }[]) {
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
            response: list.map(entry => ({
                identity: entry.identity,
                connection: { string: entry.url },
                verification: {},
                sync: { block: 0, block_hash: "", status: false },
                status: {},
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
})
