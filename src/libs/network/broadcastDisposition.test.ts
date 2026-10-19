/**
 * A broadcastTx acceptance names the transaction it took and the path that
 * took it, so a client can check the node took the bytes it signed without
 * matching message text. A staked node admits the tx itself and publishes
 * it; an unstaked node refuses outright.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"

const OUR_KEY = "aa".repeat(32)
const HASH = "0x" + "11".repeat(32)

const sharedState = {
    PROD: true,
    signingAlgorithm: "ed25519",
    lastBlockNumber: 100,
    referenceBlockRoom: 10,
}

const submitValidatedTx = jest.fn(async (..._args: unknown[]) => ({
    ok: true,
    published: true,
    confirmationBlock: 102,
    error: undefined as string | undefined,
}))
const isSelfStaked = jest.fn(async () => true)

const quietLog = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() }

jest.mock("src/utilities/logger", () => ({ __esModule: true, default: quietLog }))
jest.mock("src/utilities/sharedState", () => ({ getSharedState: sharedState }))
jest.mock("src/libs/blockchain/chain", () => ({ __esModule: true, default: { getLastBlockNumber: async () => 100 } }))
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
jest.mock("src/libs/consensus/stakedSet", () => ({ isSelfStaked }))
jest.mock("./routines/transactions/demosWork/handleDemosWorkRequest", () => ({ __esModule: true, default: jest.fn() }))
jest.mock("src/features/multichain/XMDispatcher", () => ({ __esModule: true, default: {} }))
jest.mock("./routines/transactions/handleWeb2ProxyRequest", () => ({ handleWeb2ProxyRequest: jest.fn() }))
jest.mock("../utils/web2RequestUtils", () => ({ parseWeb2ProxyRequest: jest.fn() }))
jest.mock("./routines/transactions/handleIdentityRequest", () => ({ __esModule: true, default: jest.fn() }))
jest.mock("./routines/transactions/handleNativeBridgeTx", () => ({ __esModule: true, default: jest.fn() }))
const handleL2PS = jest.fn(async (..._args: unknown[]) => ({ result: 200, response: "ok" }))
jest.mock("./routines/transactions/handleL2PS", () => ({ __esModule: true, default: handleL2PS }))

const { handleExecuteTransaction } = await import("./endpointExecution")

function validityData(): any {
    return {
        data: {
            valid: true,
            reference_block: 100,
            message: "",
            transaction: { hash: HASH, blockNumber: 101, content: { type: "native", data: ["native", {}] } },
        },
        signature: { type: "ed25519", data: "bb".repeat(64) },
        rpc_public_key: { type: "ed25519", data: OUR_KEY },
    }
}

beforeEach(() => {
    sharedState.PROD = true
    submitValidatedTx.mockClear()
    submitValidatedTx.mockImplementation(async () => ({ ok: true, published: true, confirmationBlock: 102, error: undefined }))
    isSelfStaked.mockClear()
    isSelfStaked.mockImplementation(async () => true)
    handleL2PS.mockClear()
})

describe("broadcastTx disposition", () => {
    it("mempool: this node keeps it and publishes it", async () => {
        const reply = await handleExecuteTransaction(validityData(), "sender")

        expect(reply.success).toBe(true)
        expect(reply.extra).toMatchObject({ hash: HASH, disposition: "mempool", confirmationBlock: 102, published: true })
        expect(submitValidatedTx).toHaveBeenCalledTimes(1)
    })

    it("mempool: says so when the mesh has not taken it yet", async () => {
        submitValidatedTx.mockImplementationOnce(async () => ({ ok: true, published: false, confirmationBlock: 102, error: undefined }))

        const reply = await handleExecuteTransaction(validityData(), "sender")

        expect(reply.success).toBe(true)
        expect(reply.extra).toMatchObject({ hash: HASH, disposition: "mempool", published: false })
    })

    it("refuses on an unstaked node without naming a disposition", async () => {
        isSelfStaked.mockImplementation(async () => false)

        const reply = await handleExecuteTransaction(validityData(), "sender")

        expect(reply.success).toBe(false)
        expect(reply.extra).toEqual({ error: "NOT_A_VALIDATOR" })
        expect(submitValidatedTx).not.toHaveBeenCalled()
    })

    it("mempool: an L2PS transaction accepted into this node's L2PS mempool", async () => {
        const data = validityData()
        data.data.transaction.content = { type: "l2psEncryptedTx", from: "0xaa", data: ["l2psEncryptedTx", { ciphertext: "x" }] }
        data.data.transaction.signature = { type: "ed25519", data: "cc".repeat(64) }

        const reply = await handleExecuteTransaction(data, "sender")

        expect(reply.success).toBe(true)
        expect(reply.extra).toMatchObject({ hash: HASH, disposition: "mempool" })
        expect(handleL2PS).toHaveBeenCalledTimes(1)
    })

    it("names no disposition when the mempool refuses it", async () => {
        sharedState.PROD = false
        submitValidatedTx.mockImplementationOnce(async () => ({ ok: false, published: false, confirmationBlock: undefined, error: "nonce too low" }))

        const reply = await handleExecuteTransaction(validityData(), "sender")

        expect(reply.success).toBe(false)
        expect(reply.extra.disposition).toBeUndefined()
    })
})
