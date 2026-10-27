/**
 * The OmniProtocol mempool merge feeds the same pool admission as the HTTP
 * `mempool` method, so it has the same gate: merge-eligible validators only.
 */

import { beforeEach, describe, expect, it, jest, mock } from "bun:test"

const STAKED = "0x" + "11".repeat(32)

let batch: Buffer[] = [Buffer.from(JSON.stringify({ hash: "0x1" }))]
const receive = jest.fn(async (..._args: unknown[]) => ({ success: true, mempool: [] as unknown[] }))

mock.module("src/libs/consensus/mergePeerEligibility", () => ({
    isMergePeerEligible: async (key: string) => key === STAKED,
}))
mock.module("src/libs/blockchain/mempool", () => ({ __esModule: true, default: { receive } }))
mock.module("../../serialization/sync", () => ({
    decodeBlockHashRequest: jest.fn(),
    decodeBlockSyncRequest: jest.fn(),
    decodeBlocksRequest: jest.fn(),
    decodeMempoolMergeRequest: () => ({ transactions: batch }),
    decodeMempoolSyncRequest: jest.fn(),
    decodeTransactionHashRequest: jest.fn(),
    encodeBlockResponse: jest.fn(),
    encodeBlockSyncResponse: jest.fn(),
    encodeBlocksResponse: jest.fn(),
    encodeBlockMetadata: jest.fn(),
    encodeMempoolResponse: (r: unknown) => r,
    encodeMempoolSyncResponse: jest.fn(),
}))
mock.module("../../serialization/transaction", () => ({
    decodeTransaction: jest.fn(),
    encodeTransaction: jest.fn(),
    encodeTransactionEnvelope: jest.fn(),
}))

const { handleMempoolMerge } = await import("./sync")

const call = (peerIdentity: string | undefined) =>
    (handleMempoolMerge as any)({
        message: { payload: Buffer.from("x") },
        context: { peerIdentity },
    })

beforeEach(() => {
    receive.mockClear()
    batch = [Buffer.from(JSON.stringify({ hash: "0x1" }))]
})

describe("handleMempoolMerge sender gate", () => {
    it("refuses a caller with no authenticated identity", async () => {
        expect(await call(undefined)).toEqual({ status: 401, transactions: [] })
        expect(receive).not.toHaveBeenCalled()
    })

    it("refuses an authenticated identity that is not merge-eligible", async () => {
        expect(await call("0x" + "99".repeat(32))).toEqual({ status: 401, transactions: [] })
        expect(receive).not.toHaveBeenCalled()
    })

    it("merges for an eligible validator", async () => {
        expect(await call(STAKED)).toEqual({ status: 200, transactions: [] })
        expect(receive).toHaveBeenCalledTimes(1)
    })

    it("refuses a batch longer than a pool can be", async () => {
        batch = Array.from({ length: 10_001 }, () => Buffer.from("{}"))
        expect(await call(STAKED)).toEqual({ status: 400, transactions: [] })
        expect(receive).not.toHaveBeenCalled()
    })
})
