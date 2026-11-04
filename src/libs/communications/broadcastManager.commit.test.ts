/**
 * A committed block reaches every member, its signers included, and a
 * member takes it even when it signed it or still runs its own round for
 * that height. Blocks above or at heights we hold are not dropped silently.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"

const state: any = {
    lastBlockNumber: 5,
    lastBlockHash: "h5",
    publicKeyHex: "self",
    isInitialized: true,
    inSyncLoop: false,
    syncStatus: true,
}
let chain: Record<number, any> = {}
let liveRounds = new Set<number>()
const adopt = jest.fn(async (_b: any, _p: any) => "adopted")
const conflictCheck = jest.fn(async (_o: any, _t: any, _id: string) => true)
const probe = jest.fn((_p: any, _h: number, _hash?: string) => undefined)
const pushed: string[] = []

const makePeer = (identity: string) => ({
    identity,
    connection: { string: `http://${identity}` },
    sync: {},
    longCall: async (req: any) => {
        if (req.params[0].method === "syncNewBlock") pushed.push(identity)
        return { result: 200, response: { syncData: "" } }
    },
})
const peers = [makePeer("signer-a"), makePeer("signer-b"), makePeer("other")]

jest.mock("src/utilities/logger", () => ({
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
jest.mock("@/utilities/sharedState", () => ({ getSharedState: state }))
jest.mock("src/utilities/sharedState", () => ({ getSharedState: state }))
jest.mock("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: {
        getBlockByNumber: async (n: number) => chain[n] ?? null,
        getBlockByHash: async (h: string) =>
            Object.values(chain).find((b: any) => b.hash === h) ?? null,
    },
}))
jest.mock("src/libs/peer", () => ({
    Peer: class {},
    PeerManager: {
        getInstance: () => ({
            getPeers: () => peers,
            getPeer: (id: string) => peers.find(p => p.identity === id),
            getOfflinePeers: () => ({ gone: makePeer("gone") }),
            ourSyncDataString: "1:5:h5",
            addPeer: () => true,
        }),
    },
}))
jest.mock("src/libs/consensus/v2/types/secretaryManager", () => ({
    __esModule: true,
    default: {
        getInstance: (n: number) => (liveRounds.has(n) ? { live: true } : null),
    },
}))
jest.mock("src/libs/gossip/GossipManager", () => ({
    __esModule: true,
    default: { isEnabled: () => false },
}))
jest.mock("src/libs/gossip/metrics", () => ({ observeBlockFirstSeen: () => undefined }))
jest.mock("src/libs/consensus/v2/routines/committedBlock", () => ({
    adoptCommittedBlock: adopt,
    checkConflictingBlock: conflictCheck,
    scheduleHeightProbe: probe,
}))
jest.mock("src/libs/blockchain/routines/Sync", () => ({}))

const { BroadcastManager } = await import("./broadcastManager")

const block = (number: number, hash: string, signers: string[]): any => ({
    number,
    hash,
    content: { previousHash: "h5", timestamp: 0 },
    validation_data: {
        signatures: Object.fromEntries(signers.map(s => [s, "sig"])),
    },
})

beforeEach(() => {
    state.lastBlockNumber = 5
    chain = { 5: { number: 5, hash: "h5" } }
    liveRounds = new Set()
    adopt.mockClear()
    conflictCheck.mockClear()
    probe.mockClear()
    pushed.length = 0
})

describe("pushing a committed block", () => {
    it("reaches the block's signers too", async () => {
        await BroadcastManager.broadcastNewBlock(
            block(6, "x6", ["self", "signer-a", "signer-b"]),
        )
        expect(pushed.sort()).toEqual(["other", "signer-a", "signer-b"])
    })
})

describe("receiving a committed block", () => {
    it("adopts a block we signed while our round for its height is live", async () => {
        liveRounds.add(6)
        const res = await BroadcastManager.handleNewBlock(
            "signer-a",
            block(6, "x6", ["self", "signer-a", "signer-b"]),
        )
        expect(adopt).toHaveBeenCalledTimes(1)
        expect(adopt.mock.calls[0][1].identity).toBe("signer-a")
        expect(res.result).toBe(200)
    })

    it("still names a committer that was marked offline after its push", async () => {
        await BroadcastManager.handleNewBlock("gone", block(6, "x6", ["gone"]))
        expect(adopt.mock.calls[0][1].identity).toBe("gone")
    })

    it("reports a failed adoption", async () => {
        adopt.mockImplementationOnce(async () => "rejected")
        const res = await BroadcastManager.handleNewBlock(
            "signer-a",
            block(6, "x6", ["signer-a"]),
        )
        expect(res.result).toBe(400)
    })

    it("probes the sender of a block above our next height", async () => {
        await BroadcastManager.handleNewBlock("other", block(9, "y9", ["other"]))
        expect(adopt).not.toHaveBeenCalled()
        expect(probe).toHaveBeenCalledTimes(1)
        expect(probe.mock.calls[0][0].identity).toBe("other")
        expect(probe.mock.calls[0][1]).toBe(9)
    })

    it("checks a different block at a height we hold for a fork", async () => {
        await BroadcastManager.handleNewBlock("other", {
            ...block(5, "y5", ["other"]),
        })
        expect(conflictCheck).toHaveBeenCalledTimes(1)
        expect(conflictCheck.mock.calls[0][1].hash).toBe("y5")
        expect(conflictCheck.mock.calls[0][2]).toBe("other")

        conflictCheck.mockClear()
        await BroadcastManager.handleNewBlock("other", block(5, "h5", ["other"]))
        expect(conflictCheck).not.toHaveBeenCalled()
    })

    it("probes a peer whose sync data is ahead of our head", async () => {
        await BroadcastManager.handleUpdatePeerSyncData("other", "1:23:y23")
        expect(probe).toHaveBeenCalledTimes(1)
        expect(probe.mock.calls[0][1]).toBe(23)
        expect(probe.mock.calls[0][2]).toBe("y23")
    })
})
