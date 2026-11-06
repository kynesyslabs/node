/**
 * A node restarted with gossip off hears of no new blocks, so it must ask
 * peers for their head; only heights above ours go to the verifying probe.
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
    lastBlockNumber: 100,
}
jest.mock("src/utilities/sharedState", () => ({ getSharedState: sharedState }))

let gossipEnabled = false
jest.mock("src/libs/gossip/GossipManager", () => ({
    __esModule: true,
    default: { isEnabled: () => gossipEnabled },
}))

const scheduleHeightProbe = jest.fn()
jest.mock("src/libs/consensus/v2/routines/committedBlock", () => ({
    scheduleHeightProbe,
    HEIGHT_PROBE_INTERVAL_MS: 10_000,
}))

const { pollPeerHeights } = await import("./pollPeerHeights")

function peer(identity: string, answer: () => Promise<any>) {
    return { identity, call: jest.fn(answer) } as any
}
const head = (height: unknown) => async () => ({ result: 200, response: height })

beforeEach(() => {
    gossipEnabled = false
    sharedState.lastBlockNumber = 100
    scheduleHeightProbe.mockClear()
})

describe("pollPeerHeights", () => {
    it("hands a higher peer head to the probe", async () => {
        const ahead = peer("0xahead", head(150))
        await pollPeerHeights([ahead])
        expect(ahead.call).toHaveBeenCalledTimes(1)
        expect(ahead.call.mock.calls[0][0].params[0].message).toBe(
            "getLastBlockNumber",
        )
        expect(scheduleHeightProbe).toHaveBeenCalledWith(ahead, 150)
    })

    it("ignores peers at or below our head", async () => {
        await pollPeerHeights([peer("0xlevel", head(100)), peer("0xbehind", head(90))])
        expect(scheduleHeightProbe).not.toHaveBeenCalled()
    })

    it("asks nobody while gossip is on", async () => {
        gossipEnabled = true
        const ahead = peer("0xahead", head(150))
        await pollPeerHeights([ahead])
        expect(ahead.call).not.toHaveBeenCalled()
        expect(scheduleHeightProbe).not.toHaveBeenCalled()
    })

    it("does not ask itself", async () => {
        const self = peer("0xself", head(150))
        await pollPeerHeights([self])
        expect(self.call).not.toHaveBeenCalled()
    })

    it("skips failed, refused and malformed answers without stopping the rest", async () => {
        const ahead = peer("0xahead", head(120))
        await pollPeerHeights([
            peer("0xdown", async () => {
                throw new Error("ECONNREFUSED")
            }),
            peer("0xrefused", async () => ({ result: 500, response: 999 })),
            peer("0xjunk", head("lots")),
            peer("0xfrac", head(150.5)),
            ahead,
        ])
        expect(scheduleHeightProbe).toHaveBeenCalledTimes(1)
        expect(scheduleHeightProbe).toHaveBeenCalledWith(ahead, 120)
    })

    it("does not let a peer that never answers hold the round", async () => {
        const ahead = peer("0xahead", head(130))
        const silent = peer("0xsilent", () => new Promise(() => {}))
        const outcome = await Promise.race([
            pollPeerHeights([silent, ahead], 20).then(() => "done"),
            new Promise(resolve => setTimeout(() => resolve("held"), 1_000)),
        ])
        expect(outcome).toBe("done")
        expect(scheduleHeightProbe).toHaveBeenCalledWith(ahead, 130)
    })
})
