/**
 * L2PS services follow the node's stake, but never start before the node has
 * synced: the joined networks are loaded before sync, at boot.
 */
import { afterEach, describe, expect, it, jest, mock } from "bun:test"

const hashStart = jest.fn(async () => undefined)
const hashStop = jest.fn(async () => undefined)
const aggStart = jest.fn(async () => undefined)
const aggStop = jest.fn(async () => undefined)
mock.module("./L2PSHashService", () => ({
    L2PSHashService: { getInstance: () => ({ start: hashStart, stop: hashStop }) },
}))
mock.module("./L2PSBatchAggregator", () => ({
    L2PSBatchAggregator: { getInstance: () => ({ start: aggStart, stop: aggStop }) },
}))
mock.module("@/utilities/logger", () => ({
    __esModule: true,
    default: { debug() {}, info() {}, warning() {}, warn() {}, error() {}, only() {} },
}))

import { getSharedState } from "@/utilities/sharedState"
import { syncL2PSServices } from "./roleServices"

const saved = { joined: getSharedState.l2psJoinedUids, initialized: getSharedState.isInitialized }

afterEach(() => {
    getSharedState.l2psJoinedUids = saved.joined
    getSharedState.isInitialized = saved.initialized
    for (const fn of [hashStart, hashStop, aggStart, aggStop]) fn.mockClear()
})

describe("syncL2PSServices", () => {
    it("does not start the services of a staked member before the node has synced", async () => {
        getSharedState.l2psJoinedUids = ["subnet"]
        getSharedState.isInitialized = false
        await syncL2PSServices(true)
        expect(aggStart).not.toHaveBeenCalled()
        expect(hashStart).not.toHaveBeenCalled()
    })

    it("starts them once the node is up, and stops them when the stake goes", async () => {
        getSharedState.l2psJoinedUids = ["subnet"]
        getSharedState.isInitialized = true
        await syncL2PSServices(true)
        expect(aggStart).toHaveBeenCalledTimes(1)
        getSharedState.isInitialized = false
        await syncL2PSServices(false)
        expect(aggStop).toHaveBeenCalledTimes(1)
    })
})
