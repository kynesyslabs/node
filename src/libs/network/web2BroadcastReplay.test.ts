/**
 * Broadcasting a web2Request tx makes one origin request, and of the headers
 * signed into the tx only the allow-listed ones are forwarded on it. Runs the
 * real execute path and web2 handler; only the DAHR session (the outbound
 * fetch) is replaced.
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
}))
mock.module("src/features/multichain/XMDispatcher", () => ({ __esModule: true, default: { digest: jest.fn() } }))
mock.module("./routines/transactions/handleIdentityRequest", () => ({ __esModule: true, default: jest.fn() }))
mock.module("./routines/transactions/handleNativeBridgeTx", () => ({ __esModule: true, default: jest.fn() }))
mock.module("./routines/transactions/handleL2PS", () => ({ __esModule: true, default: jest.fn() }))

// Headers of each request that reached the origin.
const originRequests: Record<string, string>[] = []
function fakeDahr(sessionId: string) {
    return {
        sessionId,
        web2Request: { raw: { action: "startProxy", method: "GET", url: "https://example.com/", headers: {} } },
        startProxy: async (params: { headers: Record<string, string> }) => {
            originRequests.push({ ...params.headers })
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

function web2Tx(from: string, headers: Record<string, string>): any {
    const payload = {
        message: {
            sessionId: "s",
            payload: "",
            authorization: "",
            web2Request: { raw: { action: "startProxy", method: "GET", url: "https://example.com/", headers } },
        },
    }
    return {
        data: {
            valid: true,
            reference_block: 100,
            message: "",
            transaction: { hash: HASH, blockNumber: 101, content: { type: "web2Request", from, data: ["web2Request", payload] } },
        },
        signature: { type: "ed25519", data: "bb".repeat(64) },
        rpc_public_key: { type: "ed25519", data: OUR_KEY },
    }
}

beforeEach(() => {
    originRequests.length = 0
})

describe("web2Request broadcast", () => {
    it("makes one origin request per broadcast, with only allow-listed headers", async () => {
        const sender = "0x" + "e1".repeat(32)
        const headers = {
            Accept: "application/json",
            "Content-Type": "application/json",
            "User-Agent": "demos-test",
            "X-Extra": "1",
            Referer: "https://example.org/",
        }
        for (let i = 1; i <= 2; i++) {
            const reply = await handleExecuteTransaction(web2Tx(sender, headers), "rpc")
            expect(reply.success).toBe(true)
            expect(reply.response?.result).toBe(200)
            expect(originRequests).toHaveLength(i)
        }
        for (const sent of originRequests) {
            expect(sent).toEqual({
                Accept: "application/json",
                "Content-Type": "application/json",
                "User-Agent": "demos-test",
            })
        }
    })

    it("matches allow-listed names in any casing and forwards nothing else", async () => {
        const sender = "0x" + "e2".repeat(32)
        await handleExecuteTransaction(
            web2Tx(sender, { ACCEPT: "text/plain", "accept-language": "en", "X-EXTRA": "1" }),
            "rpc",
        )
        await handleExecuteTransaction(web2Tx(sender, { "X-Extra": "1" }), "rpc")

        expect(originRequests).toEqual([{ ACCEPT: "text/plain", "accept-language": "en" }, {}])
    })

    it("forwards the idempotency, conditional and range headers, not custom credential headers", async () => {
        const sender = "0x" + "e3".repeat(32)
        const forwarded = {
            "Idempotency-Key": "order-7f3a",
            "If-Match": "\"etag-1\"",
            "if-none-match": "\"etag-2\"",
            "If-Modified-Since": "Wed, 21 Oct 2026 07:28:00 GMT",
            "IF-UNMODIFIED-SINCE": "Wed, 21 Oct 2026 07:28:00 GMT",
            "If-Range": "\"etag-1\"",
            Range: "bytes=0-1023",
        }
        const reply = await handleExecuteTransaction(
            web2Tx(sender, { ...forwarded, "X-Goog-Api-Key": "k", "X-Custom-Token": "t", "PRIVATE-TOKEN": "p" }),
            "rpc",
        )

        expect(reply.success).toBe(true)
        expect(originRequests).toEqual([forwarded])
    })
})
