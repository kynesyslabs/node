/**
 * A web2Request broadcast stands on the response its session already fetched
 * and attested, when the tx records that response, instead of sending the
 * request to the origin a second time.
 */

import { beforeEach, describe, expect, it, jest, mock } from "bun:test"

const quietLog = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() }
mock.module("src/utilities/logger", () => ({ __esModule: true, default: quietLog }))
mock.module("@/utilities/logger", () => ({ __esModule: true, default: quietLog }))

const { Config } = await import("src/config")
const { DAHRFactory } = await import("src/features/web2/dahr/DAHRFactory")
const { attestedWeb2Response } = await import("./web2AttestedResponse")

const fetched = {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    data: '{"a":1}',
    responseHash: "aa".repeat(32),
    responseHeadersHash: "bb".repeat(32),
    requestHash: "cc".repeat(32),
}
const claimed = {
    sessionId: "ignored",
    targetUrl: "https://example.com/a",
    timestamp: 1,
    status: 200,
    statusText: "OK",
    headers: fetched.headers,
    responseHash: fetched.responseHash,
    responseHeadersHash: fetched.responseHeadersHash,
    requestHash: fetched.requestHash,
}
const request: any = {
    raw: { action: "create", method: "GET", url: "https://example.com/a", headers: {} },
    result: null,
    hash: "",
}

let sendHTTPRequest: ReturnType<typeof jest.fn>

async function attestedSession(): Promise<string> {
    const dahr = await DAHRFactory.instance.createDAHR(request)
    ;(dahr as any)._proxy.sendHTTPRequest = sendHTTPRequest
    await dahr.startProxy({ method: "GET", headers: {}, url: "https://example.com/a" } as any)
    return dahr.sessionId
}

beforeEach(() => {
    Config.resetInstance()
    DAHRFactory.resetInstance()
    sendHTTPRequest = jest.fn(async () => ({ ...fetched }))
})

describe("attestedWeb2Response", () => {
    it("answers with the attested response once, without fetching", async () => {
        const sessionId = await attestedSession()
        const raw = { url: "https://EXAMPLE.com:443/a#x", method: "GET" }
        const reply = await attestedWeb2Response(sessionId, raw, claimed)
        expect(reply).toMatchObject({ result: 200, response: { responseHash: fetched.responseHash } })
        expect(sendHTTPRequest).toHaveBeenCalledTimes(1)
        expect(attestedWeb2Response(sessionId, raw, claimed)).toBeNull()
    })

    it("does not answer for a response the tx does not record", async () => {
        const sessionId = await attestedSession()
        const raw = { url: "https://example.com/a", method: "GET" }
        for (const other of [
            { ...claimed, responseHash: "dd".repeat(32) },
            { ...claimed, responseHeadersHash: "dd".repeat(32) },
            { ...claimed, status: 201 },
            { ...claimed, requestHash: undefined },
            null,
            "x",
        ]) {
            expect(attestedWeb2Response(sessionId, raw, other)).toBeNull()
        }
        // None of those used it up.
        expect(attestedWeb2Response(sessionId, raw, claimed)).not.toBeNull()
    })

    it("does not answer for another request, session or a bad URL", async () => {
        const sessionId = await attestedSession()
        expect(attestedWeb2Response(sessionId, { url: "https://example.com/b", method: "GET" }, claimed)).toBeNull()
        expect(attestedWeb2Response(sessionId, { url: "https://example.com/a", method: "POST" }, claimed)).toBeNull()
        expect(attestedWeb2Response("no-such-session", { url: "https://example.com/a", method: "GET" }, claimed)).toBeNull()
        expect(attestedWeb2Response(sessionId, { url: "http://[::1]/a", method: "GET" }, claimed)).toBeNull()
        expect(attestedWeb2Response(undefined, { url: "https://example.com/a", method: "GET" }, claimed)).toBeNull()
    })

    it("has nothing to answer for a session whose fetch was refused", async () => {
        sendHTTPRequest = jest.fn(async () => ({ ...fetched, status: 500, statusText: "err" }))
        const dahr = await DAHRFactory.instance.createDAHR(request)
        ;(dahr as any)._proxy.sendHTTPRequest = sendHTTPRequest
        await expect(
            dahr.startProxy({ method: "GET", headers: {}, url: "https://example.com/a" } as any),
        ).rejects.toThrow()
        const raw = { url: "https://example.com/a", method: "GET" }
        expect(attestedWeb2Response(dahr.sessionId, raw, { ...claimed, status: 500 })).toBeNull()
    })
})
