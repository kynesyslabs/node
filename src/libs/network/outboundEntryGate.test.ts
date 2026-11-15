/**
 * Requests the node makes for callers are gated at the RPC entry:
 * - an operator can switch XM, DemosWork and web2 off (XM_ENABLED,
 *   DEMOSWORK_ENABLED, WEB2_ENABLED), and the caller gets a clear refusal;
 * - a web2Request tx that carries credentials (Authorization, Cookie, API
 *   keys, a non-empty authorization field) is refused, because the signed tx
 *   is stored on chain verbatim and the node cannot strip them from it. The
 *   web2 steps of a DemosWork tx are stored the same way.
 */

import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test"
import { TXS_MAX_BYTES } from "src/libs/gossip/topics"

// The gate measures with the product function, so a change to how it counts
// bytes shows up here and not only in rpcGossipSize.test.ts. Loaded before
// the partial mocks below, which its imports could not link against.
const { gossipSizeRefusal: realGossipSizeRefusal } = await import("./txSubmission")

const OUR_KEY = "aa".repeat(32)
const HASH = "0x" + "11".repeat(32)

const sharedState = {
    PROD: false,
    signingAlgorithm: "ed25519",
    lastBlockNumber: 100,
}

const submitValidatedTx = jest.fn(async (..._args: unknown[]) => ({
    ok: true,
    published: true,
    confirmationBlock: 102,
    error: undefined as string | undefined,
}))
let gossipOn = true
const gossipSizeRefusal = jest.fn(realGossipSizeRefusal)
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
    default: { prepareEntities: async () => ({}), applyTransaction: async () => ({ success: true }) },
}))
mock.module("./txSubmission", () => ({ submitValidatedTx, gossipSizeRefusal }))
mock.module("src/libs/gossip/GossipManager", () => ({
    __esModule: true,
    default: { isEnabled: () => gossipOn },
}))
mock.module("src/libs/consensus/stakedSet", () => ({ isSelfStaked: async () => true }))
const handleDemosWorkRequest = jest.fn(async (..._args: unknown[]) => ({ result: 200, response: {} }))
mock.module("./routines/transactions/demosWork/handleDemosWorkRequest", () => ({
    __esModule: true,
    default: handleDemosWorkRequest,
}))
const digest = jest.fn(async (..._args: unknown[]) => ({ success: true, message: "all_ops_ok", results: {} }))
mock.module("src/features/multichain/XMDispatcher", () => ({ __esModule: true, default: { digest } }))
const handleWeb2ProxyRequest = jest.fn(async (..._args: unknown[]) => ({ result: 200 }))
mock.module("./routines/transactions/handleWeb2ProxyRequest", () => ({ handleWeb2ProxyRequest }))
mock.module("../utils/web2RequestUtils", () => ({
    parseWeb2ProxyRequest: (p: any) => ({
        ...p.message,
        web2Request: { raw: { ...p.message.web2Request.raw } },
    }),
}))
mock.module("./routines/transactions/handleIdentityRequest", () => ({ __esModule: true, default: jest.fn() }))
mock.module("./routines/transactions/handleNativeBridgeTx", () => ({ __esModule: true, default: jest.fn() }))
const handleL2PS = jest.fn(async (..._args: unknown[]) => ({ result: 200 }))
mock.module("./routines/transactions/handleL2PS", () => ({ __esModule: true, default: handleL2PS }))

const { handleExecuteTransaction } = await import("./endpointExecution")
const { Config: appConfig } = await import("src/config")

const SWITCHES = ["XM_ENABLED", "DEMOSWORK_ENABLED", "WEB2_ENABLED"] as const

function tx(type: string, payload: unknown): any {
    return {
        data: {
            valid: true,
            reference_block: 100,
            message: "",
            transaction: { hash: HASH, blockNumber: 101, content: { type, from: "0xaa", data: [type, payload] } },
        },
        signature: { type: "ed25519", data: "bb".repeat(64) },
        rpc_public_key: { type: "ed25519", data: OUR_KEY },
    }
}

function web2Tx(headers: Record<string, string>, authorization = "", resultHeaders: Record<string, string> = {}) {
    return tx("web2Request", {
        message: {
            sessionId: "s",
            payload: "",
            authorization,
            web2Request: {
                raw: { action: "startProxy", method: "GET", url: "https://example.com/", headers },
                result: { status: 200, headers: resultHeaders },
            },
        },
    })
}

function setSwitch(name: (typeof SWITCHES)[number], on: boolean) {
    process.env[name] = on ? "true" : "false"
    appConfig.resetInstance()
}

beforeEach(() => {
    gossipOn = true
    for (const s of SWITCHES) delete process.env[s]
    appConfig.resetInstance()
    submitValidatedTx.mockClear()
    handleDemosWorkRequest.mockClear()
    digest.mockClear()
    handleL2PS.mockClear()
    gossipSizeRefusal.mockClear()
    handleWeb2ProxyRequest.mockClear()
})

describe("tx gossip size gate before type effects", () => {
    for (const [type, effect] of [
        ["crosschainOperation", digest],
        ["subnet", handleL2PS],
    ] as const) {
        it(`refuses an oversized ${type} before its handler runs`, async () => {
            const data = tx(type, { blob: "x".repeat(TXS_MAX_BYTES + 1) })
            const reply = await handleExecuteTransaction(data, "sender")
            expect(reply.success).toBe(false)
            expect(reply.response).toEqual({ message: "Failed to add transaction to mempool" })
            expect(reply.extra).toMatchObject({ error: expect.stringContaining(`${TXS_MAX_BYTES}`) })
            expect(effect).not.toHaveBeenCalled()
            expect(submitValidatedTx).not.toHaveBeenCalled()
        })

        it(`lets a small ${type} reach its handler`, async () => {
            const reply = await handleExecuteTransaction(tx(type, {}), "sender")
            expect(reply.success).toBe(true)
            expect(effect).toHaveBeenCalledTimes(1)
            expect(submitValidatedTx).toHaveBeenCalledTimes(1)
        })
    }

    it("lets an oversized l2psEncryptedTx reach handleL2PS, since it never goes on the tx topic", async () => {
        const data = tx("l2psEncryptedTx", { encrypted_data: "x".repeat(TXS_MAX_BYTES + 1) })
        data.data.transaction.signature = { type: "ed25519", data: "cc".repeat(64) }
        const reply = await handleExecuteTransaction(data, "sender")
        expect(reply.success).toBe(true)
        expect(reply.extra).toMatchObject({ disposition: "mempool" })
        expect(handleL2PS).toHaveBeenCalledTimes(1)
        expect(submitValidatedTx).not.toHaveBeenCalled()
    })

    it("lets an oversized transaction reach the handler with gossip off", async () => {
        gossipOn = false
        const reply = await handleExecuteTransaction(
            tx("subnet", { blob: "x".repeat(TXS_MAX_BYTES + 1) }),
            "sender",
        )
        expect(reply.success).toBe(true)
        expect(gossipSizeRefusal).not.toHaveBeenCalled()
        expect(handleL2PS).toHaveBeenCalledTimes(1)
    })
})

afterEach(() => {
    for (const s of SWITCHES) delete process.env[s]
    appConfig.resetInstance()
})

describe("operator off switches", () => {
    it("XM_ENABLED=false refuses an XM tx before any outbound call", async () => {
        setSwitch("XM_ENABLED", false)
        const reply = await handleExecuteTransaction(tx("crosschainOperation", { operations: {} }), "sender")
        expect(reply.success).toBe(false)
        expect(JSON.stringify(reply)).toContain("XM_ENABLED")
        expect(digest).not.toHaveBeenCalled()
        expect(submitValidatedTx).not.toHaveBeenCalled()
    })

    it("DEMOSWORK_ENABLED=false refuses a DemosWork tx", async () => {
        setSwitch("DEMOSWORK_ENABLED", false)
        const reply = await handleExecuteTransaction(tx("demoswork", { steps: {} }), "sender")
        expect(reply.success).toBe(false)
        expect(JSON.stringify(reply)).toContain("DEMOSWORK_ENABLED")
        expect(handleDemosWorkRequest).not.toHaveBeenCalled()
        expect(submitValidatedTx).not.toHaveBeenCalled()
    })

    it("WEB2_ENABLED=false refuses a web2Request tx", async () => {
        setSwitch("WEB2_ENABLED", false)
        const reply = await handleExecuteTransaction(web2Tx({}), "sender")
        expect(reply.success).toBe(false)
        expect(JSON.stringify(reply)).toContain("WEB2_ENABLED")
        expect(handleWeb2ProxyRequest).not.toHaveBeenCalled()
        expect(submitValidatedTx).not.toHaveBeenCalled()
    })

    it("all three stay on by default", async () => {
        expect((await handleExecuteTransaction(tx("crosschainOperation", { operations: {} }), "s")).success).toBe(true)
        expect((await handleExecuteTransaction(tx("demoswork", { steps: {} }), "s")).success).toBe(true)
        expect((await handleExecuteTransaction(web2Tx({ Accept: "text/plain" }), "s")).success).toBe(true)
    })
})

describe("web2Request credentials are not put on chain", () => {
    it("refuses credential headers in any casing", async () => {
        for (const headers of [{ Authorization: "Bearer t" }, { cookie: "sid=1" }, { "X-API-KEY": "k" }]) {
            const reply = await handleExecuteTransaction(web2Tx(headers), "sender")
            expect(reply.success).toBe(false)
            expect(JSON.stringify(reply)).toContain("credential")
        }
        expect(submitValidatedTx).not.toHaveBeenCalled()
    })

    it("refuses a non-empty authorization field", async () => {
        const reply = await handleExecuteTransaction(web2Tx({}, "tok"), "sender")
        expect(reply.success).toBe(false)
        expect(submitValidatedTx).not.toHaveBeenCalled()
    })

    it("refuses a Set-Cookie recorded in the result headers", async () => {
        const reply = await handleExecuteTransaction(web2Tx({}, "", { "set-cookie": "sid=1" }), "sender")
        expect(reply.success).toBe(false)
        expect(submitValidatedTx).not.toHaveBeenCalled()
    })
})

describe("DemosWork web2 step credentials are not put on chain", () => {
    function workTx(context: string, headers: Record<string, string>, resultHeaders: Record<string, string> = {}) {
        return tx("demoswork", {
            operationOrder: ["op1"],
            operations: { op1: { operationType: "base", id: ["s1"] } },
            steps: {
                s1: {
                    id: "s1",
                    context,
                    description: "fetch",
                    content: {
                        raw: { action: "startProxy", method: "GET", url: "https://example.com/", headers },
                        result: { status: 200, headers: resultHeaders },
                    },
                    output: {},
                },
            },
        })
    }

    it("refuses a web2 step with a credential header before running or submitting it", async () => {
        for (const [headers, resultHeaders] of [
            [{ Authorization: "Bearer t" }, {}],
            [{ "x-api-key": "k" }, {}],
            [{}, { "Set-Cookie": "sid=1" }],
        ] as const) {
            const reply = await handleExecuteTransaction(workTx("web2", headers, resultHeaders), "sender")
            expect(reply.success).toBe(false)
            expect(JSON.stringify(reply)).toContain("WEB2_CREDENTIALS_IN_TX")
        }
        expect(handleDemosWorkRequest).not.toHaveBeenCalled()
        expect(submitValidatedTx).not.toHaveBeenCalled()
    })

    it("accepts a web2 step without credentials", async () => {
        const reply = await handleExecuteTransaction(workTx("web2", { Accept: "text/plain" }), "sender")
        expect(reply.success).toBe(true)
        expect(handleDemosWorkRequest).toHaveBeenCalledTimes(1)
        expect(submitValidatedTx).toHaveBeenCalledTimes(1)
    })
})
