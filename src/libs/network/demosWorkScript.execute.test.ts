/**
 * A demoswork tx whose script the DemosWork runner refuses (a repeated
 * operation or step, or more than 64 step runs) is refused at execution with
 * DEMOSWORK_SCRIPT_REFUSED: no step runs, the tx is not simulated and it is
 * not handed to the mempool. A script within the limits runs and is queued as
 * before. Runs the real execute path and DemosWork runner; the native step
 * handler, the GCR simulation and the mempool submission are mocks.
 */

import { afterEach, describe, expect, it, jest, mock } from "bun:test"

const OUR_KEY = "aa".repeat(32)
const HASH = "0x" + "11".repeat(32)
const SENDER = "0x" + "c1".repeat(32)

const sharedState = {
    PROD: false,
    signingAlgorithm: "ed25519",
    lastBlockNumber: 100,
}

const quietLog = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
    only: jest.fn(),
}
mock.module("src/utilities/logger", () => ({ __esModule: true, default: quietLog }))
mock.module("@/utilities/logger", () => ({ __esModule: true, default: quietLog }))
mock.module("src/utilities/sharedState", () => ({
    __esModule: true,
    default: { getInstance: () => sharedState },
    getSharedState: sharedState,
}))
mock.module("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getLastBlockNumber: async () => 100 },
}))
const encryption = await import("@kynesyslabs/demosdk/encryption")
mock.module("@kynesyslabs/demosdk/encryption", () => ({
    ...encryption,
    ucrypto: {
        getIdentity: async () => ({ publicKey: new Uint8Array(32).fill(0xaa) }),
    },
    uint8ArrayToHex: (bytes: Uint8Array) => Buffer.from(bytes).toString("hex"),
}))
const validityData = await import("@/libs/blockchain/validation/validityData")
mock.module("@/libs/blockchain/validation/validityData", () => ({
    ...validityData,
    verifyValidityDataSignature: async () => true,
}))

const applyTransaction = jest.fn(async () => ({ success: true }))
const handleGCR = await import("../blockchain/gcr/handleGCR")
mock.module("../blockchain/gcr/handleGCR", () => ({
    ...handleGCR,
    __esModule: true,
    default: { prepareEntities: async () => ({}), applyTransaction },
}))
const submitValidatedTx = jest.fn(async () => ({
    ok: true,
    published: true,
    confirmationBlock: 102,
}))
mock.module("./txSubmission", () => ({ submitValidatedTx }))
mock.module("src/libs/consensus/stakedSet", () => ({
    getStakedSet: async () => new Set<string>(),
    getStakedSetHeight: () => 0,
    isStaked: async () => false,
    isSelfStaked: async () => true,
    onSelfStakeChange: () => () => undefined,
    invalidateStakedSet: () => undefined,
    __resetStakedSet: () => undefined,
}))
mock.module("src/features/multichain/XMDispatcher", () => ({
    __esModule: true,
    default: { digest: jest.fn() },
}))
mock.module("./routines/transactions/handleIdentityRequest", () => ({
    __esModule: true,
    default: jest.fn(),
}))
mock.module("./routines/transactions/handleNativeBridgeTx", () => ({
    __esModule: true,
    default: jest.fn(),
}))
mock.module("./routines/transactions/handleL2PS", () => ({
    __esModule: true,
    default: jest.fn(),
}))
const handleNativeRequest = jest.fn(async () => ({ result: 200 }))
mock.module("./routines/transactions/handleNativeRequest", () => ({
    __esModule: true,
    default: handleNativeRequest,
}))

const { handleExecuteTransaction } = await import("./endpointExecution")

const step = (id: string) => ({
    id,
    context: "native",
    description: id,
    content: {},
    output: {},
})

/** A demoswork tx running base operations `order`, each over `stepIds`. */
function workTx(stepIds: string[], order: string[] = ["op1"]): any {
    const steps = Object.fromEntries(stepIds.map(id => [id, step(id)]))
    const operations = Object.fromEntries(
        order.map(name => [name, { operationType: "base", id: stepIds }]),
    )
    return {
        data: {
            valid: true,
            reference_block: 100,
            message: "",
            transaction: {
                hash: HASH,
                blockNumber: 101,
                content: {
                    type: "demoswork",
                    from: SENDER,
                    reference_block: 100,
                    data: ["demoswork", { operationOrder: order, operations, steps }],
                },
            },
        },
        signature: { type: "ed25519", data: "bb".repeat(64) },
        rpc_public_key: { type: "ed25519", data: OUR_KEY },
    }
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`)

afterEach(() => {
    applyTransaction.mockClear()
    submitValidatedTx.mockClear()
    handleNativeRequest.mockClear()
})

describe("demoswork tx execution", () => {
    it.each([
        [
            "a step listed twice",
            workTx(["s1", "s2", "s1"]),
            "DemosWork script refused: operation step list missing or not distinct",
        ],
        [
            "a step listed by two operations",
            workTx(["s1"], ["op1", "op2"]),
            "DemosWork script refused: operation step list missing or not distinct",
        ],
        [
            "an operation listed twice",
            workTx(["s1"], ["op1", "op1"]),
            "DemosWork script refused: operationOrder must list distinct operation names",
        ],
        [
            "65 step runs",
            workTx(ids(65)),
            "DemosWork script refused: more than 64 step runs",
        ],
    ])("refuses a script with %s: no step, no simulation, no mempool", async (_label, validated, message) => {
        const reply = await handleExecuteTransaction(validated, "rpc")

        expect(reply.success).toBe(false)
        expect(reply.response).toEqual({ error: "DEMOSWORK_SCRIPT_REFUSED", message })
        expect(reply.extra).toEqual({ error: "DEMOSWORK_SCRIPT_REFUSED", message })
        expect(handleNativeRequest).not.toHaveBeenCalled()
        expect(applyTransaction).not.toHaveBeenCalled()
        expect(submitValidatedTx).not.toHaveBeenCalled()
    })

    it("runs an ordinary two-step script and hands the tx to the mempool", async () => {
        const reply: any = await handleExecuteTransaction(workTx(["s1", "s2"]), "rpc")

        expect(reply.success).toBe(true)
        expect(reply.response.result).toBe(200)
        expect(reply.response.response.operationsResults[0].success).toBe(true)
        expect(handleNativeRequest).toHaveBeenCalledTimes(2)
        expect(applyTransaction).toHaveBeenCalledTimes(1)
        expect(submitValidatedTx).toHaveBeenCalledTimes(1)
        expect(reply.extra).toMatchObject({ hash: HASH, disposition: "mempool" })
    })

    it("runs 64 step runs and hands the tx to the mempool", async () => {
        const reply: any = await handleExecuteTransaction(workTx(ids(64)), "rpc")

        expect(reply.success).toBe(true)
        expect(handleNativeRequest).toHaveBeenCalledTimes(64)
        expect(submitValidatedTx).toHaveBeenCalledTimes(1)
    })
})
