/**
 * A broadcastTx acceptance names the transaction it took and the path that
 * took it, so a client can tell a held transaction (no validator has it yet)
 * from one in a mempool or with a validator, without matching message text.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"

const OUR_KEY = "aa".repeat(32)
const HASH = "0x" + "11".repeat(32)

const sharedState = {
    PROD: true,
    inConsensusLoop: false,
    signingAlgorithm: "ed25519",
    lastBlockNumber: 100,
    referenceBlockRoom: 10,
}

const addTransactionWithLock = jest.fn(async (..._args: unknown[]) => ({ confirmationBlock: 102, error: null as string | null }))
const relayTransactions = jest.fn(async (..._args: unknown[]) => ({ response: [] as any[] }))
const cacheForRetry = jest.fn()
const inConsensusHandler = jest.fn(async () => ({
    success: true,
    result: 200,
    response: { message: "Transaction received during consensus, confirmation in next block", confirmationBlock: 103 },
    extra: { confirmationBlock: 103 },
    require_reply: false,
}))
const isValidatorForNextBlock = jest.fn(async () => ({ isValidator: false, validators: [{ identity: "0xv1" }], lastBlockHash: "0xtip" }))

const quietLog = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() }

jest.mock("src/utilities/logger", () => ({ __esModule: true, default: quietLog }))
jest.mock("src/utilities/sharedState", () => ({ getSharedState: sharedState }))
jest.mock("src/libs/blockchain/chain", () => ({ __esModule: true, default: { getLastBlockNumber: async () => 100 } }))
jest.mock("src/libs/blockchain/mempool", () => ({ __esModule: true, default: { addTransactionWithLock } }))
jest.mock("@kynesyslabs/demosdk/encryption", () => ({
    ucrypto: { getIdentity: async () => ({ publicKey: new Uint8Array(32).fill(0xaa) }) },
    uint8ArrayToHex: (bytes: Uint8Array) => Buffer.from(bytes).toString("hex"),
    hexToUint8Array: (hex: string) => new Uint8Array(Buffer.from(hex.replace(/^0x/, ""), "hex")),
}))
jest.mock("../blockchain/validation/txValidatorPool", () => ({
    __esModule: true,
    default: { getInstance: () => ({ verify: async () => true }) },
}))
jest.mock("../blockchain/gcr/handleGCR", () => ({
    __esModule: true,
    default: { prepareEntities: async () => ({}), applyTransaction: async () => ({ success: true }) },
}))
jest.mock("./dtr/dtrmanager", () => ({
    DTRManager: {
        relayTransactions,
        cacheForRetry,
        inConsensusHandler,
        parkedConfirmationBlock: 104,
        readConfirmationBlock: (res: any) => res.extra?.confirmationBlock ?? null,
    },
}))
jest.mock("../consensus/v2/routines/isValidator", () => ({ __esModule: true, default: isValidatorForNextBlock }))
jest.mock("./routines/transactions/demosWork/handleDemosWorkRequest", () => ({ __esModule: true, default: jest.fn() }))
jest.mock("src/features/multichain/XMDispatcher", () => ({ __esModule: true, default: {} }))
jest.mock("./routines/transactions/handleWeb2ProxyRequest", () => ({ handleWeb2ProxyRequest: jest.fn() }))
jest.mock("../utils/web2RequestUtils", () => ({ parseWeb2ProxyRequest: jest.fn() }))
jest.mock("./routines/transactions/handleIdentityRequest", () => ({ __esModule: true, default: jest.fn() }))
jest.mock("./routines/transactions/handleNativeBridgeTx", () => ({ __esModule: true, default: jest.fn() }))
jest.mock("./routines/transactions/handleL2PS", () => ({ __esModule: true, default: jest.fn() }))

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
    sharedState.inConsensusLoop = false
    addTransactionWithLock.mockClear()
    relayTransactions.mockReset()
    cacheForRetry.mockClear()
    isValidatorForNextBlock.mockImplementation(async () => ({ isValidator: false, validators: [{ identity: "0xv1" }], lastBlockHash: "0xtip" }))
})

describe("broadcastTx disposition", () => {
    it("mempool: this node keeps it", async () => {
        isValidatorForNextBlock.mockImplementation(async () => ({ isValidator: true, validators: [], lastBlockHash: "0xtip" }))

        const reply = await handleExecuteTransaction(validityData(), "sender")

        expect(reply.success).toBe(true)
        expect(reply.extra).toMatchObject({ hash: HASH, disposition: "mempool", confirmationBlock: 102 })
    })

    it("relayed: a validator accepted it", async () => {
        relayTransactions.mockResolvedValue({ response: [{ result: 200, extra: { confirmationBlock: 105 } }] })

        const reply = await handleExecuteTransaction(validityData(), "sender")

        expect(reply.success).toBe(true)
        expect(reply.extra).toEqual({ confirmationBlock: 105, hash: HASH, disposition: "relayed" })
        expect(addTransactionWithLock).not.toHaveBeenCalled()
    })

    it("held: no validator accepted it, so it is cached for a later relay", async () => {
        relayTransactions.mockResolvedValue({ response: [{ result: 400 }] })

        const reply = await handleExecuteTransaction(validityData(), "sender")

        expect(reply.success).toBe(true)
        expect(reply.extra).toEqual({ confirmationBlock: 104, hash: HASH, disposition: "held" })
        expect(cacheForRetry).toHaveBeenCalledTimes(1)
    })

    it("held: received during consensus", async () => {
        sharedState.inConsensusLoop = true

        const reply = await handleExecuteTransaction(validityData(), "sender")

        expect(reply.extra).toEqual({ confirmationBlock: 103, hash: HASH, disposition: "held" })
    })

    it("names no disposition when the mempool refuses it", async () => {
        sharedState.PROD = false
        addTransactionWithLock.mockResolvedValueOnce({ confirmationBlock: 102, error: "nonce too low" })

        const reply = await handleExecuteTransaction(validityData(), "sender")

        expect(reply.success).toBe(false)
        expect(reply.extra.disposition).toBeUndefined()
    })
})
