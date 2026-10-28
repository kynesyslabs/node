/**
 * A peer's reported sync state counts only when our own chain backs it. A
 * height ahead of ours, or a hash we do not have, reads as unknown, so a
 * node on another chain cannot make us believe the network is ahead. Such a
 * claim from a peer we can reach is handed to the height probe, which
 * verifies the blocks before anything is adopted.
 */

import { beforeEach, describe, expect, it, jest, mock } from "bun:test"

const sharedState = { lastBlockNumber: 100 }
const blocks: Record<number, { hash: string }> = { 100: { hash: "h100" }, 99: { hash: "h99" } }

jest.mock("src/utilities/sharedState", () => ({ getSharedState: sharedState }))
jest.mock("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getBlockByNumber: async (n: number) => blocks[n] ?? null },
}))

const probe = jest.fn((_peer: unknown, _height: number, _hash?: string) => undefined)
mock.module("src/libs/consensus/v2/routines/committedBlock", () => ({
    scheduleHeightProbe: probe,
}))

const { corroborateSyncData, UNKNOWN_SYNC } = await import("./syncClaims")

const from: any = { identity: "peer-a", connection: { string: "http://a" } }

beforeEach(() => {
    sharedState.lastBlockNumber = 100
    probe.mockClear()
})

describe("corroborateSyncData", () => {
    it("keeps a claim at or below our tip that carries our hash", async () => {
        expect(await corroborateSyncData({ status: true, block: 100, block_hash: "h100" })).toEqual({
            status: true,
            block: 100,
            block_hash: "h100",
        })
        expect(await corroborateSyncData({ status: false, block: 99, block_hash: "h99" })).toEqual({
            status: false,
            block: 99,
            block_hash: "h99",
        })
    })

    it("reads a height ahead of ours as unknown", async () => {
        expect(await corroborateSyncData({ status: true, block: 529479, block_hash: "x" })).toBe(UNKNOWN_SYNC)
    })

    it("reads a hash we do not have as unknown", async () => {
        expect(await corroborateSyncData({ status: true, block: 100, block_hash: "other" })).toBe(UNKNOWN_SYNC)
        expect(await corroborateSyncData({ status: true, block: 50, block_hash: "h50" })).toBe(UNKNOWN_SYNC)
    })

    it("reads a malformed claim as unknown", async () => {
        expect(await corroborateSyncData(undefined)).toBe(UNKNOWN_SYNC)
        expect(await corroborateSyncData({ block: "100", block_hash: "h100" })).toBe(UNKNOWN_SYNC)
        expect(await corroborateSyncData({ block: -1, block_hash: "h" })).toBe(UNKNOWN_SYNC)
        expect(await corroborateSyncData({ block: 100, block_hash: "" })).toBe(UNKNOWN_SYNC)
    })
})

describe("claims we cannot back", () => {
    it("hands a height ahead of ours to the probe of the peer that made it", async () => {
        expect(await corroborateSyncData({ status: true, block: 101, block_hash: "x101" }, from)).toBe(
            UNKNOWN_SYNC,
        )
        expect(probe).toHaveBeenCalledTimes(1)
        expect(probe.mock.calls[0]).toEqual([from, 101, "x101"])
    })

    it("hands a hash other than ours at a height we hold to the probe", async () => {
        expect(await corroborateSyncData({ status: true, block: 100, block_hash: "other" }, from)).toBe(
            UNKNOWN_SYNC,
        )
        expect(probe.mock.calls[0]).toEqual([from, 100, "other"])
    })

    it("probes nothing without a peer to ask, for a claim we back, or for a malformed one", async () => {
        await corroborateSyncData({ status: true, block: 101, block_hash: "x101" })
        await corroborateSyncData({ status: true, block: 100, block_hash: "h100" }, from)
        await corroborateSyncData({ block: "101", block_hash: "x101" }, from)
        await corroborateSyncData({ block: 101, block_hash: "" }, from)
        expect(probe).not.toHaveBeenCalled()
    })

    it("still reads the claim as unknown when the probe throws", async () => {
        probe.mockImplementationOnce(() => {
            throw new Error("boom")
        })
        expect(await corroborateSyncData({ status: true, block: 101, block_hash: "x101" }, from)).toBe(
            UNKNOWN_SYNC,
        )
    })
})
