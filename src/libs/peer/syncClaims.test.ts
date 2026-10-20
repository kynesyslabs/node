/**
 * A peer's reported sync state counts only when our own chain backs it. A
 * height ahead of ours, or a hash we do not have, reads as unknown, so a
 * node on another chain cannot make us believe the network is ahead.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"

const sharedState = { lastBlockNumber: 100 }
const blocks: Record<number, { hash: string }> = { 100: { hash: "h100" }, 99: { hash: "h99" } }

jest.mock("src/utilities/sharedState", () => ({ getSharedState: sharedState }))
jest.mock("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getBlockByNumber: async (n: number) => blocks[n] ?? null },
}))

const { corroborateSyncData, UNKNOWN_SYNC } = await import("./syncClaims")

beforeEach(() => {
    sharedState.lastBlockNumber = 100
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
