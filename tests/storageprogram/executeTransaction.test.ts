import { beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals"

// handleExecuteTransaction runs at broadcast time. Storage-program edits must
// only be simulated there; the real write belongs to the block path
// (consensus applyGCREditsFromMergedMempool / Sync.syncGCRTables).

const applyToTx = jest.fn<(...args: unknown[]) => Promise<unknown>>()
const addTransaction = jest.fn<(...args: unknown[]) => Promise<unknown>>()
const isValidatorForNextBlock = jest.fn<() => Promise<unknown>>()
const relayTransactions = jest.fn<(...args: unknown[]) => Promise<unknown>>()

jest.mock("@/utilities/logger", () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        debug: jest.fn(),
        warning: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}))
jest.mock("@/utilities/sharedState", () => ({
    __esModule: true,
    getSharedState: {
        referenceBlockRoom: 5,
        inConsensusLoop: false,
        lastBlockNumber: 10,
        signingAlgorithm: "ed25519",
        PROD: false,
    },
}))
jest.mock("@/libs/blockchain/gcr/handleGCR", () => ({
    __esModule: true,
    default: { applyToTx: (...args: unknown[]) => applyToTx(...args) },
}))
jest.mock("@/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getLastBlockNumber: jest.fn(async () => 10) },
}))
jest.mock("@/libs/blockchain/mempool_v2", () => ({
    __esModule: true,
    default: {
        addTransaction: (...args: unknown[]) => addTransaction(...args),
    },
}))
jest.mock("@/libs/consensus/v2/routines/isValidator", () => ({
    __esModule: true,
    default: () => isValidatorForNextBlock(),
}))
jest.mock("@/libs/network/dtr/dtrmanager", () => ({
    __esModule: true,
    DTRManager: {
        relayTransactions: (...args: unknown[]) => relayTransactions(...args),
        validityDataCache: new Map(),
        inConsensusHandler: jest.fn(),
    },
}))
jest.mock("@/libs/crypto/hashing", () => ({
    __esModule: true,
    default: { sha256: () => "hash" },
}))
jest.mock("@/libs/blockchain/l2ps_hashes", () => ({ __esModule: true, default: {} }))
jest.mock("@/libs/blockchain/routines/validateTransaction", () => ({
    __esModule: true,
    confirmTransaction: jest.fn(),
}))
jest.mock("@/libs/crypto/cryptography", () => ({ __esModule: true, default: {} }))
jest.mock("@/libs/network/routines/transactions/handleL2PS", () => ({
    __esModule: true,
    default: jest.fn(),
}))
jest.mock("@/libs/peer/PeerManager", () => ({ __esModule: true, default: {} }))
jest.mock("@/libs/network/server_rpc", () => ({
    __esModule: true,
    emptyResponse: { result: 200, response: null, require_reply: false, extra: null },
}))
jest.mock("@/libs/consensus/v2/routines/getShard", () => ({
    __esModule: true,
    default: jest.fn(),
}))
jest.mock("@/libs/consensus/v2/routines/getCommonValidatorSeed", () => ({
    __esModule: true,
    default: jest.fn(),
}))
jest.mock(
    "@/libs/network/routines/transactions/demosWork/handleDemosWorkRequest",
    () => ({ __esModule: true, default: jest.fn() }),
)
jest.mock("@/features/multichain/XMDispatcher", () => ({
    __esModule: true,
    default: {},
}))
jest.mock("@/libs/peer", () => ({ __esModule: true, Peer: class {} }))
jest.mock("@/model/entities/GCRv2/GCR_Main", () => ({
    __esModule: true,
    GCRMain: class {},
}))
jest.mock("@/model/datasource", () => ({
    __esModule: true,
    default: { getInstance: jest.fn() },
}))
jest.mock(
    "@/libs/network/routines/transactions/handleWeb2ProxyRequest",
    () => ({ __esModule: true, handleWeb2ProxyRequest: jest.fn() }),
)
jest.mock("@/libs/l2ps/parallelNetworks", () => ({ __esModule: true, default: {} }))
jest.mock("@/libs/utils/web2RequestUtils", () => ({
    __esModule: true,
    parseWeb2ProxyRequest: jest.fn(),
}))
jest.mock("@/libs/network/routines/transactions/handleIdentityRequest", () => ({
    __esModule: true,
    default: jest.fn(),
}))
jest.mock("@/libs/network/routines/transactions/handleNativeBridgeTx", () => ({
    __esModule: true,
    default: jest.fn(),
}))
jest.mock("@kynesyslabs/demosdk/bridge", () => ({}), { virtual: true })

let ServerHandlers: typeof import("src/libs/network/endpointHandlers")["default"]

beforeAll(async () => {
    const mod = await import("src/libs/network/endpointHandlers")
    ServerHandlers = mod.default
})

// Public key returned by the ucrypto mock (32 bytes of 0x01), hex encoded
const OUR_KEY = "01".repeat(32)

function makeValidatedData(): any {
    return {
        data: {
            valid: true,
            reference_block: 10,
            message: "",
            transaction: {
                hash: "0xstoragetx",
                blockNumber: 11,
                content: {
                    type: "storageProgram",
                    from: "0xsender",
                    data: ["storageProgram", {}],
                    gcr_edits: [
                        {
                            type: "storageProgram",
                            target: "stor-1",
                            context: { operation: "APPEND_ITEM" },
                        },
                    ],
                },
            },
        },
        signature: { type: "ed25519", data: "00" },
        rpc_public_key: { type: "ed25519", data: OUR_KEY },
    }
}

describe("handleExecuteTransaction - storageProgram at broadcast time", () => {
    beforeEach(() => {
        applyToTx.mockReset()
        addTransaction.mockReset()
        isValidatorForNextBlock.mockReset()
        relayTransactions.mockReset()
        applyToTx.mockResolvedValue({ success: true, message: "" })
        addTransaction.mockResolvedValue({ confirmationBlock: 11, error: null })
        relayTransactions.mockResolvedValue({ result: 200 })
    })

    it("validator path: only simulates edits, never writes before block inclusion", async () => {
        isValidatorForNextBlock.mockResolvedValue({
            isValidator: true,
            validators: [],
        })

        const result = await ServerHandlers.handleExecuteTransaction(
            makeValidatedData(),
            "sender",
        )

        expect(result.success).toBe(true)
        expect(addTransaction).toHaveBeenCalledTimes(1)
        expect(applyToTx).toHaveBeenCalledTimes(1)
        // (tx, isRollback, simulate)
        expect(applyToTx.mock.calls[0][1]).toBe(false)
        expect(applyToTx.mock.calls[0][2]).toBe(true)
    })

    it("non-validator (relay) path: only simulates edits, never writes locally", async () => {
        isValidatorForNextBlock.mockResolvedValue({
            isValidator: false,
            validators: [{ identity: "v1" }],
        })

        const result = await ServerHandlers.handleExecuteTransaction(
            makeValidatedData(),
            "sender",
        )

        expect(result.success).toBe(true)
        expect(relayTransactions).toHaveBeenCalledTimes(1)
        expect(addTransaction).not.toHaveBeenCalled()
        const realWrites = applyToTx.mock.calls.filter(c => c[2] !== true)
        expect(realWrites).toHaveLength(0)
    })

    it("resubmitting the same validatedData never mutates state", async () => {
        isValidatorForNextBlock.mockResolvedValue({
            isValidator: true,
            validators: [],
        })
        addTransaction
            .mockResolvedValueOnce({ confirmationBlock: 11, error: null })
            .mockResolvedValueOnce({
                confirmationBlock: 11,
                error: "Transaction already in mempool",
            })

        const validated = makeValidatedData()
        await ServerHandlers.handleExecuteTransaction(validated, "sender")
        const second = await ServerHandlers.handleExecuteTransaction(
            validated,
            "sender",
        )

        expect(second.success).toBe(false)
        const realWrites = applyToTx.mock.calls.filter(c => c[2] !== true)
        expect(realWrites).toHaveLength(0)
    })

    it("simulation failure rejects the tx before it reaches the mempool", async () => {
        isValidatorForNextBlock.mockResolvedValue({
            isValidator: true,
            validators: [],
        })
        applyToTx.mockResolvedValue({
            success: false,
            message: "Storage program not found",
        })

        const result = await ServerHandlers.handleExecuteTransaction(
            makeValidatedData(),
            "sender",
        )

        expect(result.success).toBe(false)
        expect(addTransaction).not.toHaveBeenCalled()
        expect(applyToTx.mock.calls.every(c => c[2] === true)).toBe(true)
    })
})
