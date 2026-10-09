import { beforeEach, describe, expect, it, jest } from "bun:test"

jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        only: jest.fn(),
    },
}))

const shared = { lastBlockNumber: 10, publicKeyHex: "0xself" }
jest.mock("src/utilities/sharedState", () => ({ getSharedState: shared }))

let validators: Array<{ address: string | null }> = []
const getGCRValidatorsAtBlock = jest.fn(async () => validators)
jest.mock("src/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: { getGCRValidatorsAtBlock },
}))

import {
    __resetStakedSet,
    getStakedSet,
    getStakedSetHeight,
    invalidateStakedSet,
    isSelfStaked,
    isStaked,
    onSelfStakeChange,
} from "./stakedSet"

describe("stakedSet", () => {
    beforeEach(() => {
        __resetStakedSet()
        getGCRValidatorsAtBlock.mockClear()
        shared.lastBlockNumber = 10
        validators = [{ address: "0xAAA" }, { address: null }, { address: "0xself" }]
    })

    it("loads the set at head, lowercased, skipping null addresses", async () => {
        const set = await getStakedSet()
        expect([...set].sort()).toEqual(["0xaaa", "0xself"])
        expect(getStakedSetHeight()).toBe(10)
    })

    it("matches keys case-insensitively", async () => {
        expect(await isStaked("0xaaa")).toBe(true)
        expect(await isStaked("0xAAA")).toBe(true)
        expect(await isStaked("0xbbb")).toBe(false)
    })

    it("queries once per head and refreshes when the head moves", async () => {
        await getStakedSet()
        await getStakedSet()
        expect(getGCRValidatorsAtBlock).toHaveBeenCalledTimes(1)
        shared.lastBlockNumber = 11
        validators = [{ address: "0xbbb" }]
        expect(await isStaked("0xaaa")).toBe(false)
        expect(await isStaked("0xbbb")).toBe(true)
        expect(getGCRValidatorsAtBlock).toHaveBeenCalledTimes(2)
    })

    it("reports the node's own stake status", async () => {
        expect(await isSelfStaked()).toBe(true)
        shared.lastBlockNumber = 11
        validators = [{ address: "0xaaa" }]
        expect(await isSelfStaked()).toBe(false)
    })

    it("notifies listeners only when own status flips", async () => {
        const seen: boolean[] = []
        onSelfStakeChange(v => seen.push(v))
        await isSelfStaked()
        expect(seen).toEqual([true])
        shared.lastBlockNumber = 11
        await isSelfStaked()
        expect(seen).toEqual([true])
        shared.lastBlockNumber = 12
        validators = []
        await isSelfStaked()
        expect(seen).toEqual([true, false])
    })

    it("invokes a late listener immediately when already staked", async () => {
        await isSelfStaked()
        const seen: boolean[] = []
        onSelfStakeChange(v => seen.push(v))
        expect(seen).toEqual([true])
    })

    it("does not cache an empty set and recovers once validators are seeded", async () => {
        validators = []
        expect(await isStaked("0xaaa")).toBe(false)
        expect(getStakedSetHeight()).toBe(-1)
        expect(await isSelfStaked()).toBe(false)
        // table seeded at the same head
        validators = [{ address: "0xAAA" }, { address: "0xself" }]
        expect(await isStaked("0xaaa")).toBe(true)
        expect(await isSelfStaked()).toBe(true)
        expect(getStakedSetHeight()).toBe(10)
        expect(getGCRValidatorsAtBlock).toHaveBeenCalledTimes(3)
    })

    it("re-queries at the same head after invalidation", async () => {
        await getStakedSet()
        validators = [{ address: "0xBBB" }]
        expect(await isStaked("0xbbb")).toBe(false)
        invalidateStakedSet()
        expect(await isStaked("0xbbb")).toBe(true)
        expect(await isStaked("0xaaa")).toBe(false)
        expect(getGCRValidatorsAtBlock).toHaveBeenCalledTimes(2)
    })

    it("keeps the previous set when the refresh fails", async () => {
        await getStakedSet()
        shared.lastBlockNumber = 11
        getGCRValidatorsAtBlock.mockImplementationOnce(async () => {
            throw new Error("db down")
        })
        expect(await isStaked("0xaaa")).toBe(true)
        expect(getStakedSetHeight()).toBe(10)
    })
})
