/**
 * broadcastTx refuses a transaction whose reference block is outside the
 * window of the block the mempool would queue it for. While a consensus
 * round forges the next block, that is the block after it, built on a head
 * one block later than ours.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"

const OUR_KEY = "aa".repeat(32)
const HASH = "0x" + "11".repeat(32)
const HEAD = 100

const sharedState = {
    PROD: false,
    signingAlgorithm: "ed25519",
    lastBlockNumber: HEAD,
    referenceBlockRoom: 1,
}
// What Mempool.nextBlockRef() answers: the block a tx admitted now is queued for.
const queued = { block: HEAD + 1 }

const submitValidatedTx = jest.fn(async (..._args: unknown[]) => ({ ok: true, published: true, confirmationBlock: queued.block }))
const quietLog = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() }

jest.mock("src/utilities/logger", () => ({ __esModule: true, default: quietLog }))
jest.mock("src/utilities/sharedState", () => ({ getSharedState: sharedState }))
jest.mock("src/libs/blockchain/chain", () => ({ __esModule: true, default: { getLastBlockNumber: async () => HEAD } }))
jest.mock("src/libs/blockchain/mempool", () => ({ __esModule: true, default: { nextBlockRef: () => queued.block } }))
jest.mock("@kynesyslabs/demosdk/encryption", () => ({
    ucrypto: { getIdentity: async () => ({ publicKey: new Uint8Array(32).fill(0xaa) }) },
    uint8ArrayToHex: (bytes: Uint8Array) => Buffer.from(bytes).toString("hex"),
    hexToUint8Array: (hex: string) => new Uint8Array(Buffer.from(hex.replace(/^0x/, ""), "hex")),
}))
jest.mock("@/libs/blockchain/validation/validityData", () => ({ verifyValidityDataSignature: async () => true }))
jest.mock("../blockchain/gcr/handleGCR", () => ({
    __esModule: true,
    default: { prepareEntities: async () => ({}), applyTransaction: async () => ({ success: true }) },
}))
jest.mock("./txSubmission", () => ({ submitValidatedTx }))
jest.mock("src/libs/consensus/stakedSet", () => ({ isSelfStaked: async () => true }))
jest.mock("./routines/transactions/demosWork/handleDemosWorkRequest", () => ({ __esModule: true, default: jest.fn() }))
jest.mock("src/features/multichain/XMDispatcher", () => ({ __esModule: true, default: {} }))
jest.mock("./routines/transactions/handleWeb2ProxyRequest", () => ({ handleWeb2ProxyRequest: jest.fn() }))
jest.mock("../utils/web2RequestUtils", () => ({ parseWeb2ProxyRequest: jest.fn() }))
jest.mock("./routines/transactions/handleIdentityRequest", () => ({ __esModule: true, default: jest.fn() }))
jest.mock("./routines/transactions/handleNativeBridgeTx", () => ({ __esModule: true, default: jest.fn() }))
jest.mock("./routines/transactions/handleL2PS", () => ({ __esModule: true, default: jest.fn() }))

const { handleExecuteTransaction } = await import("./endpointExecution")

function validityData(referenceBlock: number): any {
    return {
        data: {
            valid: true,
            reference_block: referenceBlock,
            message: "",
            transaction: { hash: HASH, blockNumber: HEAD + 1, content: { type: "native", data: ["native", {}] } },
        },
        signature: { type: "ed25519", data: "bb".repeat(64) },
        rpc_public_key: { type: "ed25519", data: OUR_KEY },
    }
}

beforeEach(() => {
    queued.block = HEAD + 1
    submitValidatedTx.mockClear()
})

describe("broadcastTx reference block window", () => {
    it("refuses a tx confirmed at the previous head once a round forges the next block", async () => {
        // The round forges HEAD + 1, so the tx is queued for HEAD + 2, built on HEAD + 1.
        queued.block = HEAD + 2

        const reply = await handleExecuteTransaction(validityData(HEAD - 1), "sender")

        const error = "TX_REFERENCE_BLOCK_OUT_OF_RANGE_AT_INCLUSION"
        expect(reply.success).toBe(false)
        expect(reply.response).toMatchObject({ error })
        expect(reply.extra).toMatchObject({ error })
        expect(reply.extra.message).toContain(`block ${HEAD + 2}`)
        expect(submitValidatedTx).not.toHaveBeenCalled()
    })

    it("accepts a tx confirmed at the head while a round forges the next block", async () => {
        queued.block = HEAD + 2

        const reply = await handleExecuteTransaction(validityData(HEAD), "sender")

        expect(reply.success).toBe(true)
        expect(submitValidatedTx).toHaveBeenCalledTimes(1)
    })

    it("accepts a tx confirmed at the previous head when it is queued for the next block", async () => {
        const reply = await handleExecuteTransaction(validityData(HEAD - 1), "sender")

        expect(reply.success).toBe(true)
        expect(submitValidatedTx).toHaveBeenCalledTimes(1)
    })

    it("judges by the head when the queued block number is not above it", async () => {
        // A round whose manager is already gone queues for block 1.
        queued.block = 1

        const reply = await handleExecuteTransaction(validityData(HEAD - 1), "sender")

        expect(reply.success).toBe(true)
        expect(submitValidatedTx).toHaveBeenCalledTimes(1)
    })

    it("keeps the refusal of a reference block outside the window at the head", async () => {
        const reply = await handleExecuteTransaction(validityData(HEAD - 2), "sender")

        expect(reply.success).toBe(false)
        expect(reply.response).toBe(false)
        expect(reply.extra).toBe("Invalid block reference")
        expect(submitValidatedTx).not.toHaveBeenCalled()
    })
})
