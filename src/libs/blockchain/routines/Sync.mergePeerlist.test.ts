/**
 * A block's peerlist only adds the peers PeerManager accepts: addPeer returns
 * [added, reason], and a refused peer must not be reported as merged.
 */

import { afterEach, describe, expect, it, jest, mock, spyOn } from "bun:test"

mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        only: jest.fn(),
    },
}))

// Same import order as Sync.verification.test.ts: Sync and PeerManager import
// each other through the chain modules.
await import("../chain")
await import("../gcr/handleGCR")
const { default: PeerManager } = await import("@/libs/peer/PeerManager")
const { mergePeerlist } = await import("./Sync")

const listed = (identity: string) => ({
    identity,
    connection: { string: `http://${identity}.example:53550` },
    sync: { status: true, block: 1, block_hash: "h1" },
    status: { online: true, timestamp: 0, ready: true },
    verification: { status: false, message: null, timestamp: null },
})

afterEach(() => {
    mock.restore()
})

describe("mergePeerlist", () => {
    it("reports only the peers PeerManager accepted", async () => {
        const peerman = PeerManager.getInstance()
        spyOn(peerman, "getPeers").mockReturnValue([])
        spyOn(peerman, "addPeer").mockImplementation(((peer: { identity: string }) =>
            peer.identity === "accepted"
                ? [true, ""]
                : [false, "URL already bound to another identity"]) as any)

        const merged = await mergePeerlist({
            content: { peerlist: [listed("accepted"), listed("refused")] },
        } as any)

        expect(merged).toEqual(["accepted"])
    })
})
