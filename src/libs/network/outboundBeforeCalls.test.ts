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
let web2Status = 200
const handleWeb2ProxyRequest = jest.fn(async (..._args: unknown[]) => ({ result: web2Status, response: {} }))
mock.module("./routines/transactions/handleWeb2ProxyRequest", () => ({ handleWeb2ProxyRequest }))
mock.module("../utils/web2RequestUtils", () => ({
    parseWeb2ProxyRequest: () => ({ web2Request: { raw: { headers: {} } } }),
}))
let attestedReply: any = null
const attestedWeb2Response = jest.fn((..._args: unknown[]) => attestedReply)
mock.module("./routines/transactions/web2AttestedResponse", () => ({ attestedWeb2Response }))
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
    handleDemosWorkRequest.mockImplementation(async () => ({ result: 200, response: {} }))
    handleWeb2ProxyRequest.mockClear()
    web2Status = 200
    attestedReply = null
    attestedWeb2Response.mockClear()
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

describe("an outbound call that failed keeps the tx out of the mempool", () => {
    it("web2Request: a non-200 fetch is not submitted", async () => {
        web2Status = 502
        const reply = await handleExecuteTransaction(tx("web2Request", { message: {} }), "s")
        expect(reply.success).toBe(false)
        expect(handleWeb2ProxyRequest).toHaveBeenCalledTimes(1)
        expect(submitValidatedTx).not.toHaveBeenCalled()
    })

    it("web2Request: a 200 fetch is submitted", async () => {
        const reply = await handleExecuteTransaction(tx("web2Request", { message: {} }), "s")
        expect(reply.success).toBe(true)
        expect(submitValidatedTx).toHaveBeenCalledTimes(1)
    })

    it("demoswork: a failed step is not submitted, and the reply keeps the results", async () => {
        handleDemosWorkRequest.mockImplementation(async () => ({
            result: 400,
            response: { operationsResults: [{ success: false, error: "step failed" }] },
        }))
        const reply = await handleExecuteTransaction(tx("demoswork", { steps: {} }), "s")
        expect(reply.success).toBe(false)
        expect(JSON.stringify(reply.response)).toContain("step failed")
        expect(submitValidatedTx).not.toHaveBeenCalled()
    })
})

describe("web2Request broadcast reuses the attested response", () => {
    const recorded = { raw: { url: "https://example.com/a", method: "GET" }, result: { responseHash: "aa" } }

    it("does not fetch again when the session attested the recorded response", async () => {
        attestedReply = { result: 200, response: { responseHash: "aa" }, require_reply: false, extra: null }
        const reply = await handleExecuteTransaction(
            tx("web2Request", { message: { sessionId: "s1", web2Request: recorded } }),
            "s",
        )
        expect(reply.success).toBe(true)
        expect(attestedWeb2Response).toHaveBeenCalledWith("s1", recorded.raw, recorded.result)
        expect(handleWeb2ProxyRequest).not.toHaveBeenCalled()
        expect(submitValidatedTx).toHaveBeenCalledTimes(1)
    })

    it("fetches again when there is no attested response", async () => {
        const reply = await handleExecuteTransaction(
            tx("web2Request", { message: { sessionId: "s1", web2Request: recorded } }),
            "s",
        )
        expect(reply.success).toBe(true)
        expect(handleWeb2ProxyRequest).toHaveBeenCalledTimes(1)
    })

    it("still runs the admission refusals first", async () => {
        attestedReply = { result: 200, response: {}, require_reply: false, extra: null }
        admissionRefusal = "Transaction already in mempool"
        const reply = await handleExecuteTransaction(
            tx("web2Request", { message: { sessionId: "s1", web2Request: recorded } }),
            "s",
        )
        expect(reply.success).toBe(false)
        expect(attestedWeb2Response).not.toHaveBeenCalled()
    })
})
