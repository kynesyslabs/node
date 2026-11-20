/**
 * judgeIdentityTranscript on hand-written, fully revealed transcripts. The
 * request line is what differs between provers: tlsn-js (the SDK's prover)
 * writes the absolute form, `GET https://api.github.com/user HTTP/1.1`, which
 * a devnet run with the SDK showed; curl-style clients write `/user`.
 */
import { describe, expect, it } from "bun:test"
import {
    TLSN_IDENTITY_ENDPOINTS,
    TLSN_KEYLESS_IDENTITY_ENDPOINTS,
    judgeIdentityTranscript,
    tlsnIdentityEndpoint,
    tlsnIdentityEndpoints,
} from "./identityPolicy"
import type { AcceptedPresentation } from "./presentationGate"

const SENDER = "0x" + "ab".repeat(32)
const REQUEST_TX = "cd".repeat(32)
const BODY = JSON.stringify({ login: "octocat", id: 583231 })

function presentation(target: string, host = "api.github.com"): AcceptedPresentation {
    const sent = new TextEncoder().encode(
        `GET ${target} HTTP/1.1\r\n` +
            "connection: close\r\n" +
            `host: ${host}\r\n` +
            `x-demos-bind: demos-tlsn:v1:github:${SENDER}:${REQUEST_TX}\r\n` +
            "accept: application/json\r\n\r\n",
    )
    const recv = new TextEncoder().encode(
        "HTTP/1.1 200 OK\r\n" +
            "content-type: application/json\r\n" +
            `content-length: ${BODY.length}\r\n\r\n` +
            BODY,
    )
    return {
        attestationId: "ee".repeat(32),
        serverName: "api.github.com",
        time: 1_800_000_000,
        verifyingKey: { alg: "k256", hex: "02" + "11".repeat(32) },
        sent,
        sentAuthed: [[0, sent.length]],
        recv,
        recvAuthed: [[0, recv.length]],
    }
}

describe("identity link request target", () => {
    it("accepts the origin form", () => {
        const v = judgeIdentityTranscript(presentation("/user"), "github", SENDER)
        expect(v.ok).toBe(true)
        if (v.ok) expect(v.facts).toMatchObject({ username: "octocat", userId: "583231" })
    })

    it("accepts the absolute form tlsn-js sends", () => {
        const v = judgeIdentityTranscript(presentation("https://api.github.com/user"), "github", SENDER)
        expect(v.ok).toBe(true)
        if (v.ok) expect(v.facts).toMatchObject({ username: "octocat", userId: "583231" })
    })

    it.each([
        ["another resource", "https://api.github.com/users/octocat"],
        ["a query", "https://api.github.com/user?x=1"],
        ["another scheme", "http://api.github.com/user"],
        ["another host", "https://example.com/user"],
        ["a userinfo part", "https://u@api.github.com/user"],
        ["a port", "https://api.github.com:443/user"],
        ["an upper-case host", "https://API.GITHUB.COM/user"],
    ])("refuses an absolute target naming %s", (_label, target) => {
        const v = judgeIdentityTranscript(presentation(target), "github", SENDER)
        expect(v.ok).toBe(false)
        if (!v.ok) expect(v.reason).toContain("links need GET /user")
    })

    it("still checks the Host header on an absolute target", () => {
        const v = judgeIdentityTranscript(presentation("https://api.github.com/user", "example.com"), "github", SENDER)
        expect(v).toEqual({ ok: false, reason: "request Host is not api.github.com" })
    })
})

/** A fully revealed X API v2 `GET /2/users/me` exchange. */
function twitterPresentation(
    body: unknown,
    { target = "https://api.x.com/2/users/me", server = "api.x.com", purpose = "twitter" } = {},
): AcceptedPresentation {
    const json = JSON.stringify(body)
    const sent = new TextEncoder().encode(
        `GET ${target} HTTP/1.1\r\n` +
            "connection: close\r\n" +
            `host: ${server}\r\n` +
            `x-demos-bind: demos-tlsn:v1:${purpose}:${SENDER}:${REQUEST_TX}\r\n` +
            "accept: application/json\r\n\r\n",
    )
    const recv = new TextEncoder().encode(
        "HTTP/1.1 200 OK\r\n" +
            "content-type: application/json\r\n" +
            `content-length: ${json.length}\r\n\r\n` +
            json,
    )
    return {
        attestationId: "ee".repeat(32),
        serverName: server,
        time: 1_800_000_000,
        verifyingKey: { alg: "k256", hex: "02" + "11".repeat(32) },
        sent,
        sentAuthed: [[0, sent.length]],
        recv,
        recvAuthed: [[0, recv.length]],
    }
}

const ME = { data: { id: "2244994945", name: "X Dev", username: "XDevelopers" } }
const KEYLESS = tlsnIdentityEndpoints(true)

describe("twitter TLSN endpoint", () => {
    it("is in the keylessWeb2Identity table only", () => {
        expect(Object.keys(TLSN_IDENTITY_ENDPOINTS).sort()).toEqual(["discord", "github"])
        expect(Object.keys(TLSN_KEYLESS_IDENTITY_ENDPOINTS).sort()).toEqual(["discord", "github", "twitter"])
        expect(tlsnIdentityEndpoint("twitter", tlsnIdentityEndpoints(false))).toBeNull()
        expect(tlsnIdentityEndpoint("twitter")).toBeNull()
        expect(tlsnIdentityEndpoint("twitter", KEYLESS)).toMatchObject({
            server: "api.x.com",
            method: "GET",
            path: "/2/users/me",
        })
        // The other contexts read the same endpoints under both tables.
        expect(KEYLESS.github).toBe(TLSN_IDENTITY_ENDPOINTS.github)
        expect(KEYLESS.discord).toBe(TLSN_IDENTITY_ENDPOINTS.discord)
    })

    it("reads data.username and the decimal-string data.id", () => {
        const extract = TLSN_KEYLESS_IDENTITY_ENDPOINTS.twitter.extract
        expect(extract(ME)).toEqual({ username: "XDevelopers", userId: "2244994945" })
        expect(extract({ data: { id: "0", username: "a" } })).toEqual({ username: "a", userId: "0" })
    })

    it.each([
        ["no data", {}],
        ["data null", { data: null }],
        ["data an array", { data: [ME.data] }],
        ["the account at the top level", ME.data],
        ["a numeric id", { data: { id: 2244994945, username: "XDevelopers" } }],
        ["a padded id", { data: { id: "02244994945", username: "XDevelopers" } }],
        ["a signed id", { data: { id: "-1", username: "XDevelopers" } }],
        ["an id of 33 digits", { data: { id: "1".repeat(33), username: "XDevelopers" } }],
        ["no username", { data: { id: "2244994945" } }],
        ["an empty username", { data: { id: "2244994945", username: "" } }],
        ["a username over 256", { data: { id: "2244994945", username: "x".repeat(257) } }],
    ])("finds no account with %s", (_label, body) => {
        expect(TLSN_KEYLESS_IDENTITY_ENDPOINTS.twitter.extract(body as Record<string, unknown>)).toBeNull()
    })

    it("links from a GET /2/users/me transcript under the keyless table", () => {
        const v = judgeIdentityTranscript(twitterPresentation(ME), "twitter", SENDER, KEYLESS)
        expect(v.ok).toBe(true)
        if (v.ok) expect(v.facts).toMatchObject({ username: "XDevelopers", userId: "2244994945", serverName: "api.x.com" })
        const origin = judgeIdentityTranscript(twitterPresentation(ME, { target: "/2/users/me" }), "twitter", SENDER, KEYLESS)
        expect(origin.ok).toBe(true)
    })

    it("refuses the same transcript under the table before the fork", () => {
        expect(judgeIdentityTranscript(twitterPresentation(ME), "twitter", SENDER)).toEqual({
            ok: false,
            reason: "TLSN context twitter cannot be linked with a TLSNotary proof",
        })
    })

    it("refuses another server", () => {
        const v = judgeIdentityTranscript(
            twitterPresentation(ME, { target: "https://api.twitter.com/2/users/me", server: "api.twitter.com" }),
            "twitter",
            SENDER,
            KEYLESS,
        )
        expect(v).toEqual({ ok: false, reason: "presentation is from api.twitter.com, twitter links come from api.x.com" })
    })

    it("refuses another resource and a bind for another context", () => {
        const other = judgeIdentityTranscript(
            twitterPresentation(ME, { target: "https://api.x.com/2/users/by/username/XDevelopers" }),
            "twitter",
            SENDER,
            KEYLESS,
        )
        expect(other).toMatchObject({ ok: false, reason: expect.stringContaining("links need GET /2/users/me") })
        const bind = judgeIdentityTranscript(twitterPresentation(ME, { purpose: "github" }), "twitter", SENDER, KEYLESS)
        expect(bind).toEqual({ ok: false, reason: "X-Demos-Bind names github, the link is for twitter" })
    })

    it("refuses a response with a numeric id or without data", () => {
        for (const body of [{ data: { id: 2244994945, username: "XDevelopers" } }, { errors: [] }]) {
            expect(judgeIdentityTranscript(twitterPresentation(body), "twitter", SENDER, KEYLESS)).toEqual({
                ok: false,
                reason: "response has no twitter account",
            })
        }
    })
})
