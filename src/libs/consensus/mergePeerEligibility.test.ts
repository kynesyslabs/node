/**
 * Who may take part in the mempool merge: whoever shard selection admits. On
 * a chain with no validator rows that must not be nobody, or every node would
 * know only its own pool; a failure to read the validator set must be an
 * unknown, logged as one, not an empty set.
 */

import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test"

const STAKED = "0x" + "ab".repeat(32)
const OUTSIDER = "0x" + "22".repeat(32)
const KNOWN = "0x" + "33".repeat(32)
const SELF = "0x" + "44".repeat(32)

const log = { debug: jest.fn(), info: jest.fn(), warning: jest.fn(), warn: jest.fn(), error: jest.fn(), only: jest.fn() }
let stakedSet = new Set<string>()
const getGCRValidatorsAtBlock = jest.fn(async (..._a: unknown[]) => [] as unknown[])
const getEligiblePool = jest.fn(async (..._a: unknown[]) => [] as string[])

mock.module("src/utilities/logger", () => ({ __esModule: true, default: log }))
mock.module("src/utilities/sharedState", () => ({
    getSharedState: { lastBlockNumber: 7, publicKeyHex: SELF },
}))
mock.module("src/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: { getGCRValidatorsAtBlock },
}))
mock.module("src/libs/peer", () => ({
    PeerManager: {
        getInstance: () => ({ getPeer: (id: string) => (id === KNOWN ? {} : undefined) }),
    },
}))
mock.module("./stakedSet", () => ({ getStakedSet: async () => stakedSet }))
mock.module("./v2/routines/getShard", () => ({ getEligiblePool }))

const { isMergePeerEligible } = await import("./mergePeerEligibility")

const savedRequire = process.env.DEMOS_REQUIRE_VALIDATORS

beforeEach(() => {
    stakedSet = new Set()
    getGCRValidatorsAtBlock.mockReset()
    getGCRValidatorsAtBlock.mockImplementation(async () => [])
    getEligiblePool.mockReset()
    getEligiblePool.mockImplementation(async () => [])
    log.error.mockClear()
    delete process.env.DEMOS_REQUIRE_VALIDATORS
})

afterEach(() => {
    if (savedRequire === undefined) delete process.env.DEMOS_REQUIRE_VALIDATORS
    else process.env.DEMOS_REQUIRE_VALIDATORS = savedRequire
})

describe("a chain with validators", () => {
    beforeEach(() => {
        stakedSet = new Set([STAKED])
    })

    it("admits a member of the active validator set without any further lookup", async () => {
        expect(await isMergePeerEligible("0x" + "AB".repeat(32))).toBe(true)
        expect(getGCRValidatorsAtBlock).not.toHaveBeenCalled()
        expect(getEligiblePool).not.toHaveBeenCalled()
    })

    it("admits a member of the eligible pool the set has not caught up with", async () => {
        getEligiblePool.mockImplementation(async () => [OUTSIDER])
        expect(await isMergePeerEligible(OUTSIDER)).toBe(true)
        expect(getEligiblePool).toHaveBeenCalledWith(7)
    })

    it("refuses a key that is in neither", async () => {
        expect(await isMergePeerEligible(OUTSIDER)).toBe(false)
    })

    it("refuses an anonymous caller", async () => {
        expect(await isMergePeerEligible("")).toBe(false)
    })

    it("does not open up just because a peer is known", async () => {
        expect(await isMergePeerEligible(KNOWN)).toBe(false)
    })
})

describe("a chain with no validator rows", () => {
    it("admits a peer this node knows, and itself, like shard selection's local view", async () => {
        expect(await isMergePeerEligible(KNOWN)).toBe(true)
        expect(await isMergePeerEligible(SELF)).toBe(true)
    })

    it("still refuses a key nobody has heard of", async () => {
        expect(await isMergePeerEligible(OUTSIDER)).toBe(false)
    })

    it("refuses everyone when validators are required, as shard selection does", async () => {
        process.env.DEMOS_REQUIRE_VALIDATORS = "true"
        getEligiblePool.mockImplementation(async () => {
            throw new Error("no active validators AND DEMOS_REQUIRE_VALIDATORS=true")
        })
        expect(await isMergePeerEligible(KNOWN)).toBe(false)
        expect(log.error.mock.calls.some(c => String(c[0]).includes("DEMOS_REQUIRE_VALIDATORS=true"))).toBe(true)
    })

    it("admits a member of the eligible pool even when validators are required", async () => {
        process.env.DEMOS_REQUIRE_VALIDATORS = "true"
        getEligiblePool.mockImplementation(async () => [OUTSIDER])
        expect(await isMergePeerEligible(OUTSIDER)).toBe(true)
    })
})

describe("a failure to read the validator set", () => {
    it("denies as unknown and logs the cause at error level, instead of reading as an empty set", async () => {
        getGCRValidatorsAtBlock.mockImplementation(async () => {
            throw new Error("connection terminated")
        })
        expect(await isMergePeerEligible(KNOWN)).toBe(false)
        const line = log.error.mock.calls.map(c => String(c[0])).find(l => l.includes("cannot read the validator set"))
        expect(line).toContain("block 7")
        expect(line).toContain("connection terminated")
        expect(line).toContain(KNOWN)
    })

    it("denies and logs when the eligible pool cannot be resolved", async () => {
        stakedSet = new Set([STAKED])
        getEligiblePool.mockImplementation(async () => {
            throw new Error("block 6 not found")
        })
        expect(await isMergePeerEligible(OUTSIDER)).toBe(false)
        expect(log.error.mock.calls.some(c => String(c[0]).includes("block 6 not found"))).toBe(true)
    })
})
