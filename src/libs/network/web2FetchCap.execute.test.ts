/**
 * A signed tx also makes the node fetch: a web2Request tx replays its request
 * when executed, and each web2 step of a DemosWork tx runs one. Those fetches
 * are counted against the tx sender, so a sender cannot use tx execution to
 * get around the per-caller cap. Runs the real execute path, DemosWork runner
 * and web2 handler; only the DAHR session (the outbound fetch) is replaced.
 */

import { beforeEach, describe, expect, it, jest, mock } from "bun:test"

const OUR_KEY = "aa".repeat(32)
const HASH = "0x" + "11".repeat(32)

const sharedState = {
    PROD: false,
    signingAlgorithm: "ed25519",
    lastBlockNumber: 100,
}

const quietLog = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() }
mock.module("src/utilities/logger", () => ({ __esModule: true, default: quietLog }))
mock.module("@/utilities/logger", () => ({ __esModule: true, default: quietLog }))
mock.module("src/utilities/sharedState", () => ({
    __esModule: true,
    default: { getInstance: () => sharedState },
    getSharedState: sharedState,
}))
mock.module("src/libs/blockchain/chain", () => ({ __esModule: true, default: { getLastBlockNumber: async () => 100 } }))
const encryption = await import("@kynesyslabs/demosdk/encryption")
mock.module("@kynesyslabs/demosdk/encryption", () => ({
    ...encryption,
    ucrypto: { getIdentity: async () => ({ publicKey: new Uint8Array(32).fill(0xaa) }) },
    uint8ArrayToHex: (bytes: Uint8Array) => Buffer.from(bytes).toString("hex"),
}))
const validityData = await import("@/libs/blockchain/validation/validityData")
mock.module("@/libs/blockchain/validation/validityData", () => ({
    ...validityData,
    verifyValidityDataSignature: async () => true,
}))
const handleGCR = await import("../blockchain/gcr/handleGCR")
mock.module("../blockchain/gcr/handleGCR", () => ({
    ...handleGCR,
    __esModule: true,
    default: { prepareEntities: async () => ({}), applyTransaction: async () => ({ success: true }) },
}))
mock.module("./txSubmission", () => ({
    submitValidatedTx: async () => ({ ok: true, published: true, confirmationBlock: 102 }),
}))
mock.module("src/libs/consensus/stakedSet", () => ({
    getStakedSet: async () => new Set<string>(),
    getStakedSetHeight: () => 0,
    isStaked: async () => false,
    isSelfStaked: async () => true,
    onSelfStakeChange: () => () => undefined,
    invalidateStakedSet: () => undefined,
    __resetStakedSet: () => undefined,
}))
mock.module("src/features/multichain/XMDispatcher", () => ({ __esModule: true, default: { digest: jest.fn() } }))
mock.module("./routines/transactions/handleIdentityRequest", () => ({ __esModule: true, default: jest.fn() }))
mock.module("./routines/transactions/handleNativeBridgeTx", () => ({ __esModule: true, default: jest.fn() }))
mock.module("./routines/transactions/handleL2PS", () => ({ __esModule: true, default: jest.fn() }))

const started: string[] = []
function fakeDahr(sessionId: string) {
    return {
        sessionId,
        web2Request: { raw: { action: "startProxy", method: "GET", url: "https://example.com/", headers: {} } },
        startProxy: async (params: { url: string; meter?: { bytes: number } }) => {
            started.push(params.url)
            if (params?.meter) params.meter.bytes += 2
            return { status: 200, statusText: "OK", headers: {}, data: "ok" }
        },
    }
}
mock.module("src/features/web2/dahr/DAHRFactory", () => ({
    DAHRFactory: {
        instance: {
            getDAHR: (sessionId: string) => fakeDahr(sessionId),
            createDAHR: async () => fakeDahr("created"),
        },
    },
}))

const { handleExecuteTransaction } = await import("./endpointExecution")

function tx(type: string, from: string, payload: unknown): any {
    return {
        data: {
            valid: true,
            reference_block: 100,
            message: "",
            transaction: { hash: HASH, blockNumber: 101, content: { type, from, data: [type, payload] } },
        },
        signature: { type: "ed25519", data: "bb".repeat(64) },
        rpc_public_key: { type: "ed25519", data: OUR_KEY },
    }
}

function web2Tx(from: string, url: string) {
    return tx("web2Request", from, {
        message: {
            sessionId: "s",
            payload: "",
            authorization: "",
            web2Request: { raw: { action: "startProxy", method: "GET", url, headers: {} } },
        },
    })
}

function workTx(from: string, urls: string[]) {
    const steps: Record<string, unknown> = {}
    urls.forEach((url, i) => {
        steps[`s${i}`] = {
            id: `s${i}`,
            context: "web2",
            description: `fetch ${i}`,
            content: { raw: { action: "startProxy", method: "GET", url, headers: {} } },
            output: {},
        }
    })
    return tx("demoswork", from, {
        operationOrder: ["op1"],
        operations: { op1: { operationType: "base", id: Object.keys(steps) } },
        steps,
    })
}

beforeEach(() => {
    started.length = 0
})

describe("web2 fetches run by tx execution are counted against the sender", () => {
    it("refuses a sender's 11th web2Request replay in a minute; another sender is served", async () => {
        const sender = "0x" + "c1".repeat(32)
        for (let i = 1; i <= 10; i++) {
            const reply = await handleExecuteTransaction(web2Tx(sender, `https://example.com/w${i}`), "rpc")
            expect([i, reply.response?.result]).toEqual([i, 200])
        }
        const eleventh = await handleExecuteTransaction(web2Tx(sender, "https://example.com/w11"), "rpc")
        expect(eleventh.response?.result).toBe(429)
        expect(eleventh.response?.response).toMatchObject({ error: "WEB2_FETCH_LIMITED", reason: "caller-rate" })
        expect(started).not.toContain("https://example.com/w11")

        const other = await handleExecuteTransaction(web2Tx("0x" + "c2".repeat(32), "https://example.com/o1"), "rpc")
        expect(other.response?.result).toBe(200)
    })

    it("counts each DemosWork web2 step, and fails the step past the sender's cap", async () => {
        const sender = "0x" + "d1".repeat(32)
        const urls = Array.from({ length: 12 }, (_, i) => `https://example.com/d${i + 1}`)
        const reply = await handleExecuteTransaction(workTx(sender, urls), "rpc")
        const result = reply.response as { result: number; response: { operationsResults: { success: boolean; error: string }[] } }

        // The 11th step is refused, so the operation stops there.
        expect(started).toEqual(urls.slice(0, 10))
        expect(result.response.operationsResults[0].success).toBe(false)
        expect(result.response.operationsResults[0].error).toContain("fetch 10")
        expect(result.response.operationsResults[0].error).toContain("web2 fetches per minute")

        // The same sender's plain web2Request is now refused too: one budget.
        const replay = await handleExecuteTransaction(web2Tx(sender, "https://example.com/after"), "rpc")
        expect(replay.response?.result).toBe(429)

        // Another sender's DemosWork still runs.
        started.length = 0
        await handleExecuteTransaction(workTx("0x" + "d2".repeat(32), ["https://example.com/e1"]), "rpc")
        expect(started).toEqual(["https://example.com/e1"])
    })
})
