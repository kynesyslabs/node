/**
 * Our sync data is the only way a peer that missed a block push learns we
 * are ahead when gossip is off. A peer counts as having it only once it took
 * it: one that was unreachable, was offline, or could not corroborate it yet
 * is sent the same value again instead of being skipped as a duplicate.
 */

import { beforeEach, describe, expect, it, jest, mock } from "bun:test"

const state: any = {
    lastBlockNumber: 5,
    lastBlockHash: "h5",
    publicKeyHex: "self",
    syncStatus: true,
}

type Reply = "accepted" | "behind" | "unreachable"
const replies: Record<string, Reply> = {}
const sent: Array<[string, string]> = []

const makePeer = (identity: string) => ({
    identity,
    connection: { string: `http://${identity}` },
    sync: {},
    longCall: async (req: any) => {
        const data = req.params[0].params[0]
        sent.push([identity, data])
        const reply = replies[identity] ?? "accepted"
        if (reply === "unreachable") {
            return { result: 400, response: "Max retries reached" }
        }
        return {
            result: 200,
            response: {
                result: reply === "accepted" ? 200 : 400,
                syncData: "",
            },
        }
    },
})
let online: any[] = []
let chainBlocks: Record<number, { hash: string }> = {}
let addPeerResult: [boolean, string] = [true, ""]

let gossipReady = false
const publish = jest.fn(async () => true)

mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        only: jest.fn(),
        warn: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
    },
}))
mock.module("@/utilities/sharedState", () => ({ getSharedState: state }))
mock.module("src/utilities/sharedState", () => ({ getSharedState: state }))
mock.module("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: {
        getBlockByNumber: async (n: number) => chainBlocks[n] ?? null,
        getBlockByHash: async () => null,
    },
}))
mock.module("src/libs/peer", () => ({
    Peer: class {
        sync: any = {}
        constructor(
            public url?: string,
            public identity?: string,
        ) {}
    },
    PeerManager: {
        getInstance: () => ({
            getPeers: () => online,
            getPeer: (id: string) => online.find(p => p.identity === id),
            getOfflinePeers: () => ({}),
            ourSyncDataString: "1:5:h5",
            addPeer: () => addPeerResult,
        }),
    },
}))
mock.module("src/libs/consensus/v2/types/secretaryManager", () => ({
    __esModule: true,
    default: { getInstance: () => null },
}))
mock.module("src/libs/gossip/GossipManager", () => ({
    __esModule: true,
    default: {
        isEnabled: () => gossipReady,
        getInstance: () => ({ isReady: () => gossipReady, publishOwnHeights: publish }),
    },
}))
mock.module("src/libs/gossip/metrics", () => ({ observeBlockFirstSeen: () => undefined }))
mock.module("src/libs/consensus/v2/routines/committedBlock", () => ({
    adoptCommittedBlock: jest.fn(),
    checkConflictingBlock: jest.fn(),
    scheduleHeightProbe: jest.fn(),
}))
mock.module("src/libs/blockchain/routines/Sync", () => ({}))

const { BroadcastManager } = await import("./broadcastManager")

const sentTo = () => sent.map(([id]) => id).sort()

beforeEach(() => {
    state.lastBlockNumber = 5
    state.lastBlockHash = "h5"
    online = [makePeer("a"), makePeer("b")]
    chainBlocks = {}
    addPeerResult = [true, ""]
    for (const id of Object.keys(replies)) delete replies[id]
    sent.length = 0
    gossipReady = false
    publish.mockReset()
    publish.mockImplementation(async () => true)
    ;(BroadcastManager as any).deliveredSyncData.clear()
    ;(BroadcastManager as any).lastBroadcastSyncData = null
})

describe("sync data over HTTP", () => {
    it("is sent once to a peer that took it, and again when our head moves", async () => {
        await BroadcastManager.broadcastOurSyncData()
        await BroadcastManager.broadcastOurSyncData()
        expect(sentTo()).toEqual(["a", "b"])

        state.lastBlockNumber = 6
        state.lastBlockHash = "h6"
        await BroadcastManager.broadcastOurSyncData()
        expect(sentTo()).toEqual(["a", "a", "b", "b"])
        expect(sent.slice(-2).map(([, d]) => d)).toEqual(["1:6:h6", "1:6:h6"])
    })

    it("is sent again to a peer that could not be reached, with our head unchanged", async () => {
        replies.b = "unreachable"
        await BroadcastManager.broadcastOurSyncData()
        replies.b = "accepted"
        await BroadcastManager.broadcastOurSyncData()
        await BroadcastManager.broadcastOurSyncData()
        expect(sent).toEqual([
            ["a", "1:5:h5"],
            ["b", "1:5:h5"],
            ["b", "1:5:h5"],
        ])
    })

    it("is sent again to a peer behind us until it can corroborate it", async () => {
        replies.b = "behind"
        await BroadcastManager.broadcastOurSyncData()
        await BroadcastManager.broadcastOurSyncData()
        replies.b = "accepted"
        await BroadcastManager.broadcastOurSyncData()
        await BroadcastManager.broadcastOurSyncData()
        expect(sentTo()).toEqual(["a", "b", "b", "b"])
    })

    it("is sent again to a peer that went offline and came back", async () => {
        await BroadcastManager.broadcastOurSyncData()
        const b = online.pop()
        await BroadcastManager.broadcastOurSyncData()
        online.push(b)
        await BroadcastManager.broadcastOurSyncData()
        expect(sent).toEqual([
            ["a", "1:5:h5"],
            ["b", "1:5:h5"],
            ["b", "1:5:h5"],
        ])
    })

    it("reports no delivery when every peer already holds our head", async () => {
        expect(await BroadcastManager.broadcastOurSyncData()).toBe(true)
        expect(await BroadcastManager.broadcastOurSyncData()).toBe(false)
    })
})

describe("sync data over gossip", () => {
    it("is published again after a failed publish, and once after a successful one", async () => {
        gossipReady = true
        publish.mockImplementationOnce(async () => false)
        await BroadcastManager.broadcastOurSyncData()
        await BroadcastManager.broadcastOurSyncData()
        await BroadcastManager.broadcastOurSyncData()
        expect(publish).toHaveBeenCalledTimes(2)
        expect(sent).toEqual([])
    })
})

describe("a peer's sync data report", () => {
    it("is answered 200 once the peer is added", async () => {
        chainBlocks = { 5: { hash: "h5" } }
        const reply = await BroadcastManager.handleUpdatePeerSyncData("a", "1:5:h5")
        expect(reply.result).toBe(200)
    })

    it("is answered 400 with the reason when the peer is refused", async () => {
        chainBlocks = { 5: { hash: "h5" } }
        addPeerResult = [false, "URL already bound to another identity: http://a"]
        const reply = await BroadcastManager.handleUpdatePeerSyncData("a", "1:5:h5")
        expect(reply.result).toBe(400)
        expect(reply.message).toBe("URL already bound to another identity: http://a")
    })
})
