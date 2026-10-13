/**
 * Authenticated history read: what the caller's signature is bound to.
 *
 * Version 2 names the node and the page being read, so a relay can neither
 * present the signature to another node nor change which rows come back.
 * The unversioned form is still accepted and behaves as before.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"
import forge from "node-forge"

const getAccountTransactions = jest.fn(async (..._args: unknown[]) => [] as any[])

jest.mock("../../blockchain/l2ps_mempool", () => ({
    __esModule: true,
    default: { getByUID: jest.fn() },
    L2PS_STATUS: {},
}))

jest.mock("../../l2ps/L2PSTransactionExecutor", () => ({
    __esModule: true,
    default: { getAccountTransactions },
}))

jest.mock("@/libs/l2ps/historyPayload", () => ({
    resolveHistoryMessage: jest.fn(async () => null),
    subnetDecryptor: jest.fn(async () => undefined),
}))

const NODE_KEY = "0x" + "ab".repeat(32)

const sharedState: Record<string, unknown> = {}
jest.mock("src/utilities/sharedState", () => ({ getSharedState: sharedState }))

jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        only: jest.fn(),
    },
}))

// Imported once the mocks are registered: a static import is evaluated first,
// loads the real mempool, and cycles back through the handler index.
const { l2psHandlers } = await import("./l2psHandlers")

const keypair = forge.pki.ed25519.generateKeyPair()
const address = "0x" + Buffer.from(keypair.publicKey).toString("hex")
const UID = "subnet-1"

const sign = (message: string) =>
    "0x" +
    Buffer.from(
        forge.pki.ed25519.sign({ message, encoding: "utf8", privateKey: keypair.privateKey }),
    ).toString("hex")

const v2Message = (
    host: string,
    timestamp: string,
    limit: string | number = 100,
    offset: string | number = 0,
    since: string | number = 0,
) => `getL2PSHistory/2:${UID}:${address}:${timestamp}:${host}:${limit}:${offset}:${since}`

const call = async (data: Record<string, unknown>) => {
    const response: any = {}
    await l2psHandlers.getL2PSAccountTransactions(
        { l2psUid: UID, address, ...data } as any,
        response,
    )
    return response
}

const v2Request = (message: string, timestamp: string, extra: Record<string, unknown> = {}) => ({
    signatureVersion: 2,
    host: NODE_KEY,
    timestamp,
    signature: sign(message),
    ...extra,
})

beforeEach(() => {
    getAccountTransactions.mockReset()
    getAccountTransactions.mockResolvedValue([])
    sharedState.publicKeyHex = NODE_KEY
    sharedState.exposedUrl = "https://node-a.example.org:53550"
})

describe("getL2PSAccountTransactions, version 2 signature", () => {
    it("accepts a signature bound to the node address and the applied defaults", async () => {
        const ts = String(Date.now())
        const response = await call(v2Request(v2Message(NODE_KEY, ts), ts))

        expect(response.result).toBe(200)
        expect(getAccountTransactions).toHaveBeenCalledWith(UID, address, 101, 0, 0)
    })

    it("accepts the node address regardless of case and 0x prefix", async () => {
        const ts = String(Date.now())
        const host = NODE_KEY.slice(2).toUpperCase()
        const response = await call(v2Request(v2Message(host, ts), ts, { host }))

        expect(response.result).toBe(200)
    })

    it("accepts the advertised hostname, with or without the port", async () => {
        for (const host of ["node-a.example.org", "node-a.example.org:53550"]) {
            const ts = String(Date.now())
            const response = await call(v2Request(v2Message(host, ts), ts, { host }))
            expect(response.result).toBe(200)
        }
    })

    it("signs the page values that are applied", async () => {
        const ts = String(Date.now())
        const since = Date.now() - 1000
        const response = await call(
            v2Request(v2Message(NODE_KEY, ts, 25, 50, since), ts, { limit: 25, offset: 50, since }),
        )

        expect(response.result).toBe(200)
        expect(getAccountTransactions).toHaveBeenCalledWith(UID, address, 26, 50, since)
    })

    it("signs the clamped limit when the caller asks for more than the maximum", async () => {
        const ts = String(Date.now())
        const asked = await call(v2Request(v2Message(NODE_KEY, ts, 1000), ts, { limit: 5000 }))
        expect(asked.result).toBe(200)

        const unclamped = await call(v2Request(v2Message(NODE_KEY, ts, 5000), ts, { limit: 5000 }))
        expect(unclamped.result).toBe(403)
    })

    it("refuses a signature bound to another node", async () => {
        const ts = String(Date.now())
        const other = "0x" + "cd".repeat(32)
        const response = await call(v2Request(v2Message(other, ts), ts, { host: other }))

        expect(response.result).toBe(403)
        expect(response.response).toBe("Signature is bound to another host.")
        expect(getAccountTransactions).not.toHaveBeenCalled()
    })

    it("refuses a host swapped after signing", async () => {
        const ts = String(Date.now())
        const response = await call(
            v2Request(v2Message("node-b.example.org", ts), ts, { host: "node-a.example.org" }),
        )

        expect(response.result).toBe(403)
        expect(getAccountTransactions).not.toHaveBeenCalled()
    })

    it("does not treat a loopback advertised URL as an identity", async () => {
        sharedState.exposedUrl = "http://localhost:53550"
        const ts = String(Date.now())
        const response = await call(v2Request(v2Message("localhost", ts), ts, { host: "localhost" }))

        expect(response.result).toBe(403)
        expect(response.response).toBe("Signature is bound to another host.")
    })

    it.each([
        ["limit", { limit: 10 }],
        ["offset", { offset: 5 }],
        ["since", { since: 1234 }],
    ])("refuses a %s that differs from the signed one", async (_name, tampered) => {
        const ts = String(Date.now())
        const response = await call(v2Request(v2Message(NODE_KEY, ts), ts, tampered))

        expect(response.result).toBe(403)
        expect(response.response).toContain("Invalid signature")
        expect(getAccountTransactions).not.toHaveBeenCalled()
    })

    it("refuses a request that omits a value the signature names", async () => {
        const ts = String(Date.now())
        const response = await call(v2Request(v2Message(NODE_KEY, ts, 10, 5, 0), ts))

        expect(response.result).toBe(403)
        expect(getAccountTransactions).not.toHaveBeenCalled()
    })

    it("refuses a message with a field missing", async () => {
        const ts = String(Date.now())
        const short = `getL2PSHistory/2:${UID}:${address}:${ts}:${NODE_KEY}:100:0`
        const response = await call(v2Request(short, ts))

        expect(response.result).toBe(403)
        expect(getAccountTransactions).not.toHaveBeenCalled()
    })

    it("refuses a v2 request that names no host", async () => {
        const ts = String(Date.now())
        const response = await call(v2Request(v2Message(NODE_KEY, ts), ts, { host: undefined }))

        expect(response.result).toBe(401)
        expect(getAccountTransactions).not.toHaveBeenCalled()
    })

    it("refuses a non-integer page value instead of signing it", async () => {
        const ts = String(Date.now())
        const response = await call(v2Request(v2Message(NODE_KEY, ts, 10.5), ts, { limit: 10.5 }))

        expect(response.result).toBe(400)
        expect(getAccountTransactions).not.toHaveBeenCalled()
    })

    it("refuses a legacy signature presented as version 2", async () => {
        const ts = String(Date.now())
        const legacy = `getL2PSHistory:${UID}:${address}:${ts}`
        const response = await call(v2Request(legacy, ts))

        expect(response.result).toBe(403)
    })

    it("refuses a version 2 signature once the marker is stripped", async () => {
        const ts = String(Date.now())
        const response = await call({
            timestamp: ts,
            signature: sign(v2Message(NODE_KEY, ts)),
        })

        expect(response.result).toBe(403)
    })

    it("refuses a stale timestamp", async () => {
        const ts = String(Date.now() - 6 * 60 * 1000)
        const response = await call(v2Request(v2Message(NODE_KEY, ts), ts))

        expect(response.result).toBe(401)
        expect(response.response).toBe("Request expired or invalid timestamp.")
    })
})

describe("getL2PSAccountTransactions, unversioned signature", () => {
    const legacyRequest = (timestamp: string, extra: Record<string, unknown> = {}) => ({
        timestamp,
        signature: sign(`getL2PSHistory:${UID}:${address}:${timestamp}`),
        ...extra,
    })

    it("is still accepted", async () => {
        const ts = String(Date.now())
        const response = await call(legacyRequest(ts))

        expect(response.result).toBe(200)
        expect(getAccountTransactions).toHaveBeenCalledWith(UID, address, 101, 0, 0)
    })

    it("keeps applying the unsigned page values", async () => {
        const ts = String(Date.now())
        const response = await call(legacyRequest(ts, { limit: 7, offset: 3, since: 9 }))

        expect(response.result).toBe(200)
        expect(getAccountTransactions).toHaveBeenCalledWith(UID, address, 8, 3, 9)
    })

    it("does not need a host", async () => {
        sharedState.publicKeyHex = null
        sharedState.exposedUrl = ""
        const ts = String(Date.now())
        const response = await call(legacyRequest(ts))

        expect(response.result).toBe(200)
    })

    it("refuses a stale timestamp", async () => {
        const ts = String(Date.now() - 6 * 60 * 1000)
        const response = await call(legacyRequest(ts))

        expect(response.result).toBe(401)
        expect(response.response).toBe("Request expired or invalid timestamp.")
    })

    it("refuses a bad signature", async () => {
        const ts = String(Date.now())
        const response = await call({ timestamp: ts, signature: sign("something else") })

        expect(response.result).toBe(403)
    })
})
