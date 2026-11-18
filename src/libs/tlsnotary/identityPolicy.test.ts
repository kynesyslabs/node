/**
 * judgeIdentityTranscript on hand-written, fully revealed transcripts. The
 * request line is what differs between provers: tlsn-js (the SDK's prover)
 * writes the absolute form, `GET https://api.github.com/user HTTP/1.1`, which
 * a devnet run with the SDK showed; curl-style clients write `/user`.
 */
import { describe, expect, it } from "bun:test"
import { judgeIdentityTranscript } from "./identityPolicy"
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
