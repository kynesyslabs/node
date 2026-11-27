/**
 * A web2Request broadcast stands on the response its session already fetched
 * and attested, when the tx records that response, instead of sending the
 * request to the origin a second time. The status and hashes of a response
 * stay as long as the session, whether or not its body still fits.
 */

import { beforeEach, describe, expect, it, jest, mock } from "bun:test"

const quietLog = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() }
mock.module("src/utilities/logger", () => ({ __esModule: true, default: quietLog }))
mock.module("@/utilities/logger", () => ({ __esModule: true, default: quietLog }))
const realConstants = await import("src/utilities/constants")
mock.module("src/utilities/constants", () => ({ ...realConstants, WEB2_ATTESTED_RETAIN_MS: 20 }))

const { Config } = await import("src/config")
const { DAHRFactory } = await import("src/features/web2/dahr/DAHRFactory")
const { attestedWeb2Response } = await import("./web2AttestedResponse")
const { __resetAttestedBudget, retainedAttestedBytes, reserveAttestedBytes } = await import(
    "src/features/web2/dahr/attestedBudget"
)
const { WEB2_ATTESTED_RETAIN_MAX_BYTES, WEB2_ATTESTED_PER_SESSION } = await import(
    "src/utilities/constants"
)

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

// What a broadcast gets when the body is gone: the status and hashes only.
const evidenceOnly = {
    status: 200,
    statusText: "OK",
    headers: {},
    data: null,
    responseHash: fetched.responseHash,
    responseHeadersHash: fetched.responseHeadersHash,
    requestHash: fetched.requestHash,
}

beforeEach(() => {
    Config.resetInstance()
    // A fresh factory reads the config reset above.
    ;(DAHRFactory as any)._instance = undefined
    __resetAttestedBudget()
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

describe("attested response budget", () => {
    const body = Buffer.byteLength(fetched.data)

    it("counts a kept response and frees it when the broadcast takes it", async () => {
        const sessionId = await attestedSession()
        expect(retainedAttestedBytes()).toBe(body)
        expect(attestedWeb2Response(sessionId, request.raw, claimed)).not.toBeNull()
        expect(retainedAttestedBytes()).toBe(0)
    })

    it("frees a kept response when its session stops", async () => {
        const sessionId = await attestedSession()
        await DAHRFactory.instance.getDAHR(sessionId)!.stopProxy()
        expect(retainedAttestedBytes()).toBe(0)
        expect(attestedWeb2Response(sessionId, request.raw, claimed)).toBeNull()
    })

    it("past the node-wide budget keeps no body, and still answers the broadcast with the hashes", async () => {
        expect(reserveAttestedBytes(WEB2_ATTESTED_RETAIN_MAX_BYTES)).toBe(true)
        const sessionId = await attestedSession()
        expect(retainedAttestedBytes()).toBe(WEB2_ATTESTED_RETAIN_MAX_BYTES)
        const reply = attestedWeb2Response(sessionId, request.raw, claimed)
        expect(reply).toEqual({ result: 200, response: evidenceOnly, require_reply: false, extra: null })
        expect(sendHTTPRequest).toHaveBeenCalledTimes(1)
        expect(attestedWeb2Response(sessionId, request.raw, claimed)).toBeNull()
    })

    it("frees the body after its retention time and still answers the broadcast once", async () => {
        const sessionId = await attestedSession()
        await Bun.sleep(60)
        expect(retainedAttestedBytes()).toBe(0)
        expect(attestedWeb2Response(sessionId, request.raw, claimed)?.response).toEqual(evidenceOnly)
        expect(attestedWeb2Response(sessionId, request.raw, claimed)).toBeNull()
    })
})

describe("several responses in one session", () => {
    function responseFor(url: string) {
        const tag = url.slice(-1)
        return { ...fetched, responseHash: tag.repeat(64), data: `{"u":"${tag}"}` }
    }
    const claimFor = (url: string) => ({ ...claimed, targetUrl: url, responseHash: responseFor(url).responseHash })

    async function sessionWith(urls: string[]): Promise<string> {
        const dahr = await DAHRFactory.instance.createDAHR(request)
        ;(dahr as any)._proxy.sendHTTPRequest = jest.fn(async (p: any) => responseFor(p.web2Request.raw.url))
        await Promise.all(urls.map(url => dahr.startProxy({ method: "GET", headers: {}, url } as any)))
        return dahr.sessionId
    }

    it("answers the broadcast of each, in any order, after a later start in the session", async () => {
        const urls = ["https://example.com/1", "https://example.com/2", "https://example.com/3"]
        const sessionId = await sessionWith(urls)
        for (const url of [...urls].reverse()) {
            const reply = attestedWeb2Response(sessionId, { url, method: "GET" }, claimFor(url))
            expect(reply?.response).toMatchObject({ responseHash: responseFor(url).responseHash, data: responseFor(url).data })
        }
        expect(retainedAttestedBytes()).toBe(0)
    })

    it(`keeps at most ${WEB2_ATTESTED_PER_SESSION}, dropping the oldest and its body`, async () => {
        const urls = Array.from({ length: WEB2_ATTESTED_PER_SESSION + 1 }, (_, i) => `https://example.com/${i}`)
        const dahr = await DAHRFactory.instance.createDAHR(request)
        ;(dahr as any)._proxy.sendHTTPRequest = jest.fn(async (p: any) => responseFor(p.web2Request.raw.url))
        for (const url of urls) await dahr.startProxy({ method: "GET", headers: {}, url } as any)
        const perBody = Buffer.byteLength(responseFor(urls[1]).data)
        expect(retainedAttestedBytes()).toBe(WEB2_ATTESTED_PER_SESSION * perBody)
        expect(attestedWeb2Response(dahr.sessionId, { url: urls[0], method: "GET" }, claimFor(urls[0]))).toBeNull()
        const last = urls[urls.length - 1]
        expect(attestedWeb2Response(dahr.sessionId, { url: last, method: "GET" }, claimFor(last))).not.toBeNull()
    })
})
