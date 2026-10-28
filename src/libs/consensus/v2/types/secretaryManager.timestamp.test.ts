/**
 * A member adopts the secretary's block timestamp only when it would sign
 * it: a whole number of seconds, not far ahead of the member's own clock.
 * A refused value never becomes the round's timestamp.
 */

import { beforeEach, describe, expect, jest, test } from "bun:test"

const OUR_KEY = "0x" + "aa".repeat(32)
const SECRETARY = "0x" + "11".repeat(32)
const NOW = 1_700_000_000

const sharedState: Record<string, any> = {
    lastBlockNumber: 100,
    lastBlockHash: "hash-100",
    publicKeyHex: OUR_KEY,
    shardSize: 4,
    forkConfig: {},
}

jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warning: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        only: jest.fn(),
    },
}))
jest.mock("src/utilities/sharedState", () => ({
    __esModule: true,
    default: sharedState,
    getSharedState: sharedState,
}))
jest.mock("src/libs/utils/calibrateTime", () => ({
    getNetworkTimestamp: () => NOW,
}))
jest.mock("src/libs/peer", () => ({ Peer: class {}, PeerManager: { getInstance: () => ({}) } }))
jest.mock("src/libs/blockchain/chain", () => ({ __esModule: true, default: {} }))

const { default: SecretaryManager } = await import("./secretaryManager")

let secretaryReply: unknown

function memberManager() {
    const manager = SecretaryManager.getInstance(101, true)
    manager.shard = {
        CVSA: "seed",
        members: [
            {
                identity: SECRETARY,
                connection: { string: "http://secretary" },
                call: async () => secretaryReply,
            },
        ],
        validationPhases: {},
        secretaryKey: SECRETARY,
        blockRef: 101,
    } as any
    manager.ourValidatorPhase = { currentPhase: 1, waitStatus: true } as any
    manager.blockTimestamp = null
    return manager
}

beforeEach(() => {
    (SecretaryManager as any).instances.clear()
    secretaryReply = null
})

describe("receiveGreenLight timestamp", () => {
    test("adopts a timestamp at our clock", async () => {
        const manager = memberManager()
        expect(await manager.receiveGreenLight(NOW, 1)).toBe(true)
        expect(manager.blockTimestamp).toBe(NOW)
    })

    test("refuses a fractional timestamp and keeps none", async () => {
        const manager = memberManager()
        expect(await manager.receiveGreenLight(NOW - 0.25, 1)).toBe(false)
        expect(manager.blockTimestamp).toBeNull()
    })

    test("refuses a timestamp far ahead of our clock", async () => {
        const manager = memberManager()
        expect(await manager.receiveGreenLight(NOW + 30, 1)).toBe(false)
        expect(manager.blockTimestamp).toBeNull()
    })

    test("does not replace an adopted timestamp with a refused one", async () => {
        const manager = memberManager()
        await manager.receiveGreenLight(NOW, 1)
        expect(await manager.receiveGreenLight(NOW + 30, 1)).toBe(false)
        expect(manager.blockTimestamp).toBe(NOW)
    })

    test("still takes a greenlight that carries no timestamp", async () => {
        const manager = memberManager()
        expect(await manager.receiveGreenLight(undefined, 1)).toBe(true)
        expect(manager.blockTimestamp).toBeNull()
    })
})

describe("getSecretaryBlockTimestamp", () => {
    test("adopts the secretary's timestamp when we would sign it", async () => {
        const manager = memberManager()
        secretaryReply = { result: 200, response: [NOW - 3] }
        expect(await manager.getSecretaryBlockTimestamp()).toBe(NOW - 3)
        expect(manager.blockTimestamp).toBe(NOW - 3)
    })

    test("refuses a fractional or far-ahead timestamp", async () => {
        const manager = memberManager()
        for (const value of [NOW + 0.5, NOW + 30, "1700000000"]) {
            secretaryReply = { result: 200, response: [value] }
            expect(await manager.getSecretaryBlockTimestamp()).toBeNull()
            expect(manager.blockTimestamp).toBeNull()
        }
    })
})
