/**
 * A forged tx envelope costs its transport origin, never the publisher it
 * claims, and an origin that keeps forging runs out of signature checks.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"

const PUBLISHER = "aa".repeat(32)

const verify = jest.fn(async (_vd: unknown) => false)
const quietLog = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() }

jest.mock("src/utilities/logger", () => ({ __esModule: true, default: quietLog }))
jest.mock("@/utilities/sharedState", () => ({ getSharedState: { signingAlgorithm: "ed25519", lastBlockNumber: 100 } }))
jest.mock("src/libs/consensus/stakedSet", () => ({
    isStaked: async () => true,
    getStakedSet: async () => new Set([PUBLISHER]),
    getStakedSetHeight: () => 100,
}))
jest.mock("src/libs/blockchain/validation/validityData", () => ({ verifyValidityDataSignature: verify }))
jest.mock("src/libs/blockchain/validation/verifyBlock", () => ({ verifyBlock: async () => ({ valid: true }) }))
jest.mock("@/forks", () => ({ serializeBlockContent: () => "" }))
jest.mock("src/libs/crypto/hashing", () => ({ __esModule: true, default: { sha256: () => "" } }))
jest.mock("./records", () => ({ isHeightsRecordShape: () => false, verifyHeightsRecord: async () => false }))
jest.mock("./metrics", () => ({ countTxRateLimited: jest.fn(), recordVerdict: jest.fn() }))

const { validateTxMessage } = await import("./validators")
const { TXS_ORIGIN_BURST } = await import("./topics")

function envelope(n: number): Uint8Array {
    return new TextEncoder().encode(
        JSON.stringify({
            data: { reference_block: 100, transaction: { hash: "0x" + n.toString(16).padStart(64, "0") } },
            signature: { type: "ed25519", data: "bb".repeat(64) },
            rpc_public_key: { type: "ed25519", data: PUBLISHER },
        }),
    )
}

beforeEach(() => {
    verify.mockClear()
    verify.mockImplementation(async () => false)
})

describe("validateTxMessage origin budget", () => {
    it("stops checking signatures for an origin that keeps forging, and leaves the publisher's budget alone", async () => {
        for (let i = 0; i < TXS_ORIGIN_BURST; i++) {
            expect((await validateTxMessage(envelope(i), "forger")).result).toBe("reject")
        }
        expect(verify).toHaveBeenCalledTimes(TXS_ORIGIN_BURST)

        expect((await validateTxMessage(envelope(TXS_ORIGIN_BURST), "forger")).result).toBe("ignore")
        expect(verify).toHaveBeenCalledTimes(TXS_ORIGIN_BURST)

        verify.mockImplementation(async () => true)
        expect((await validateTxMessage(envelope(TXS_ORIGIN_BURST + 1), "honest")).result).toBe("accept")
    })
})
