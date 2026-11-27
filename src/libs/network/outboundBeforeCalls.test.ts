/**
 * A cross-chain or DemosWork broadcast runs every refusal that does not
 * depend on its outbound calls before making them, and a re-broadcast of the
 * same tx never makes them a second time.
 */

import { beforeEach, describe, expect, it, jest, mock } from "bun:test"

// Loaded before the partial mocks below, which its imports could not link against.
const realAdmission = await import("./outboundAdmission")

const OUR_KEY = "aa".repeat(32)
const sharedState = { PROD: false, signingAlgorithm: "ed25519", lastBlockNumber: 100 }
let admissionRefusal: string | null = null
let simulateOk = true
let staked = true

const submitValidatedTx = jest.fn(async (..._args: unknown[]) => ({
    ok: true,
    published: true,
    confirmationBlock: 102,
    error: undefined as string | undefined,
}))
const quietLog = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() }

mock.module("src/utilities/logger", () => ({ __esModule: true, default: quietLog }))
mock.module("@/utilities/logger", () => ({ __esModule: true, default: quietLog }))
mock.module("src/utilities/sharedState", () => ({ getSharedState: sharedState }))
mock.module("src/libs/blockchain/chain", () => ({ __esModule: true, default: { getLastBlockNumber: async () => 100 } }))
mock.module("@kynesyslabs/demosdk/encryption", () => ({
    ucrypto: { getIdentity: async () => ({ publicKey: new Uint8Array(32).fill(0xaa) }) },
    uint8ArrayToHex: (bytes: Uint8Array) => Buffer.from(bytes).toString("hex"),
    hexToUint8Array: (hex: string) => new Uint8Array(Buffer.from(hex.replace(/^0x/, ""), "hex")),
}))
mock.module("@/libs/blockchain/validation/validityData", () => ({ verifyValidityDataSignature: async () => true }))
mock.module("../blockchain/gcr/handleGCR", () => ({
    __esModule: true,
    default: {
        prepareEntities: async () => ({}),
        applyTransaction: async () => ({ success: simulateOk, message: "insufficient balance" }),
    },
    withDerivedFeeEdits: (tx: unknown) => tx,
}))
mock.module("./txSubmission", () => ({ submitValidatedTx, gossipSizeRefusal: () => null }))
mock.module("./outboundAdmission", () => ({
    ...realAdmission,
    outboundAdmissionRefusal: async () => admissionRefusal,
}))
mock.module("src/libs/gossip/GossipManager", () => ({ __esModule: true, default: { isEnabled: () => true } }))
mock.module("src/libs/blockchain/mempool", () => ({ __esModule: true, default: { nextBlockRef: () => 101 } }))
mock.module("src/libs/consensus/stakedSet", () => ({ isSelfStaked: async () => staked }))
const handleDemosWorkRequest = jest.fn(async (..._args: unknown[]) => ({ result: 200, response: {} }))
mock.module("./routines/transactions/demosWork/handleDemosWorkRequest", () => ({
    __esModule: true,
    default: handleDemosWorkRequest,
}))
let digestReply: any = { success: true, message: "all_ops_ok", results: {} }
const digest = jest.fn(async (..._args: unknown[]) => digestReply)
mock.module("src/features/multichain/XMDispatcher", () => ({ __esModule: true, default: { digest } }))
mock.module("./routines/transactions/handleIdentityRequest", () => ({ __esModule: true, default: jest.fn() }))
mock.module("./routines/transactions/handleNativeBridgeTx", () => ({ __esModule: true, default: jest.fn() }))
mock.module("./routines/transactions/handleL2PS", () => ({ __esModule: true, default: jest.fn() }))

const { handleExecuteTransaction, OUTBOUND_ALREADY_RUN } = await import("./endpointExecution")

function tx(type: string, payload: unknown, hash = "0x" + "11".repeat(32)): any {
    return {
        data: {
            valid: true,
            reference_block: 100,
            message: "",
            transaction: { hash, blockNumber: 101, content: { type, from: "0xaa", data: [type, payload], reference_block: 100 } },
        },
        signature: { type: "ed25519", data: "bb".repeat(64) },
        rpc_public_key: { type: "ed25519", data: OUR_KEY },
    }
}

const OUTBOUND = [
    ["crosschainOperation", { operations: {} }, digest],
    ["demoswork", { steps: {} }, handleDemosWorkRequest],
] as const

beforeEach(() => {
    realAdmission.__resetOutboundClaims()
    admissionRefusal = null
    simulateOk = true
    staked = true
    sharedState.PROD = false
    digestReply = { success: true, message: "all_ops_ok", results: {} }
    submitValidatedTx.mockClear()
    digest.mockClear()
    handleDemosWorkRequest.mockClear()
})

describe("refusals run before outbound calls", () => {
    for (const [type, payload, effect] of OUTBOUND) {
        it(`${type}: a dry-run admission refusal stops it before any call`, async () => {
            admissionRefusal = "Transaction already in mempool"
            const reply = await handleExecuteTransaction(tx(type, payload), "s")
            expect(reply.success).toBe(false)
            expect(reply.response).toEqual({ message: "Failed to add transaction to mempool" })
            expect(reply.extra).toMatchObject({ error: "Transaction already in mempool" })
            expect(effect).not.toHaveBeenCalled()
            expect(submitValidatedTx).not.toHaveBeenCalled()
        })

        it(`${type}: a failed GCR simulation stops it before any call`, async () => {
            simulateOk = false
            const reply = await handleExecuteTransaction(tx(type, payload), "s")
            expect(reply.success).toBe(false)
            expect(JSON.stringify(reply.extra)).toContain("insufficient balance")
            expect(effect).not.toHaveBeenCalled()
        })

        it(`${type}: an unstaked production node refuses it before any call`, async () => {
            sharedState.PROD = true
            staked = false
            const reply = await handleExecuteTransaction(tx(type, payload), "s")
            expect(reply.success).toBe(false)
            expect(reply.extra).toMatchObject({ error: "NOT_A_VALIDATOR" })
            expect(effect).not.toHaveBeenCalled()
        })

        it(`${type}: a re-broadcast does not run the calls again`, async () => {
            const first = await handleExecuteTransaction(tx(type, payload), "s")
            expect(first.success).toBe(true)
            const again = await handleExecuteTransaction(tx(type, payload), "s")
            expect(again.success).toBe(false)
            expect(again.extra).toMatchObject({ error: OUTBOUND_ALREADY_RUN })
            expect(effect).toHaveBeenCalledTimes(1)
            expect(submitValidatedTx).toHaveBeenCalledTimes(1)

            const other = await handleExecuteTransaction(tx(type, payload, "0x" + "22".repeat(32)), "s")
            expect(other.success).toBe(true)
            expect(effect).toHaveBeenCalledTimes(2)
        })

        it(`${type}: a refused tx does not use up its claim`, async () => {
            admissionRefusal = "busy"
            await handleExecuteTransaction(tx(type, payload), "s")
            admissionRefusal = null
            const reply = await handleExecuteTransaction(tx(type, payload), "s")
            expect(reply.success).toBe(true)
            expect(effect).toHaveBeenCalledTimes(1)
        })
    }
})

describe("XM verdict", () => {
    it("a partly executed script is not submitted, and the reply lists what was sent", async () => {
        digestReply = {
            success: false,
            message: "partial_ops_ok",
            results: { a: { result: "success", hash: "0xabc" }, b: { result: "error" } },
        }
        const reply = await handleExecuteTransaction(tx("crosschainOperation", { operations: {} }), "s")
        expect(reply.success).toBe(false)
        expect(JSON.stringify(reply.response)).toContain("0xabc")
        expect(submitValidatedTx).not.toHaveBeenCalled()
    })
})
