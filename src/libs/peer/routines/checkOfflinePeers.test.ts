/**
 * A quiet peer that answers the probe is alive and must leave the probe
 * fresh. Relying on the transport to refresh it left Omni peers stale, so
 * they were probed again on every recheck and dropped from the online set.
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
    inPeerRecheckLoop: false,
    lastPeerRecheck: 0,
    peerRecheckSleepTime: 0,
    getConsensusTime: () => 1,
}
jest.mock("src/utilities/sharedState", () => ({ getSharedState: sharedState }))

const { default: PeerManager } = await import("../PeerManager")
const { default: Peer } = await import("../Peer")
const { default: checkOfflinePeers } = await import("./checkOfflinePeers")

const peerman = PeerManager.getInstance()
const online = () => (peerman as any).peerList as Record<string, any>
const offline = () => (peerman as any).offlinePeers as Record<string, any>
const STALE = 1_000

/** A peer listed online whose last contact is far outside the window. */
function quietPeer(identity: string, answers: boolean) {
    const peer = new Peer("http://10.0.0.9:53550", identity)
    peer.status.online = true
    peer.status.timestamp = STALE
    // Answers without touching last-seen, as the Omni path used to.
    peer.connect = jest.fn(async () => answers)
    online()[identity] = peer
    return peer
}

beforeEach(() => {
    for (const key of Object.keys(online())) delete online()[key]
    for (const key of Object.keys(offline())) delete offline()[key]
    sharedState.inPeerRecheckLoop = false
    sharedState.lastPeerRecheck = 0
})

describe("checkOfflinePeers quiet-peer probe", () => {
    it("keeps a peer that answers online and fresh", async () => {
        const peer = quietPeer("0xalive", true)

        await checkOfflinePeers()

        expect(peer.connect).toHaveBeenCalledTimes(1)
        expect(online()["0xalive"]).toBe(peer)
        expect(offline()["0xalive"]).toBeUndefined()
        expect(peerman.isPeerFresh(peer)).toBe(true)
        expect(peerman.getQuietPeers()).toHaveLength(0)
        expect((await peerman.getOnlinePeers()).map(p => p.identity)).toContain(
            "0xalive",
        )
    })

    it("moves a peer that does not answer to the offline table", async () => {
        const peer = quietPeer("0xgone", false)

        await checkOfflinePeers()

        expect(online()["0xgone"]).toBeUndefined()
        expect(offline()["0xgone"]).toBe(peer)
        expect(peer.status.online).toBe(false)
    })
})
