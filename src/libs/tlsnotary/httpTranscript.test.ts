import { describe, expect, it } from "bun:test"
import {
    parseAuthedRequest,
    parseAuthedResponse,
    parseAuthedResponseHead,
    singleHeader,
    type AuthedBytes,
} from "./httpTranscript"

/**
 * A transcript where `[` and `]` mark hidden spans: the brackets are dropped
 * and the bytes between them are zeroed, as the verifier zeroes unrevealed
 * bytes, and left out of the authed ranges.
 */
function transcript(marked: string): AuthedBytes {
    const bytes: number[] = []
    const authed: [number, number][] = []
    let hidden = false
    let start = 0
    for (const ch of marked) {
        if (ch === "[" || ch === "]") {
            if (!hidden && bytes.length > start) authed.push([start, bytes.length])
            hidden = ch === "["
            if (!hidden) start = bytes.length
            continue
        }
        bytes.push(hidden ? 0 : ch.charCodeAt(0))
    }
    if (!hidden && bytes.length > start) authed.push([start, bytes.length])
    return { bytes: new Uint8Array(bytes), authed }
}

const body = (r: ReturnType<typeof parseAuthedResponse>) =>
    r.ok === false ? `refused: ${r.reason}` : Buffer.from(r.value.body).toString("latin1")
const reason = (r: { ok: boolean; reason?: string }) => (r.ok ? "accepted" : r.reason)

const GET = "GET /user HTTP/1.1\r\nhost: api.example\r\n"

describe("parseAuthedRequest", () => {
    it("reads the request line and headers, skipping hidden lines", () => {
        const r = parseAuthedRequest(transcript(`${GET}[authorization: Bearer x]\r\nx-demos-bind: v\r\n\r\n`))
        expect(r.ok).toBe(true)
        if (!r.ok) return
        expect([r.value.method, r.value.target, r.value.version]).toEqual(["GET", "/user", "HTTP/1.1"])
        expect(r.value.headers.map(h => h.name)).toEqual(["host", "x-demos-bind"])
    })

    it("reports a header whose value is hidden as present but not revealed", () => {
        const r = parseAuthedRequest(transcript(`${GET}authorization: [Bearer x]\r\n\r\n`))
        expect(r.ok && r.value.headers[1]).toEqual({ name: "authorization", value: null, valueRevealed: false })
    })

    it("refuses a partly revealed value", () => {
        expect(reason(parseAuthedRequest(transcript(`${GET}cookie: a=[secret]\r\n\r\n`)))).toContain(
            "cookie header value is partly revealed",
        )
    })

    it("refuses a value whose hidden span could end the line and hide a credential's name", () => {
        // Hidden: "\r\nauthorization: "; the token after it is revealed.
        const r = parseAuthedRequest(transcript(`${GET}x-note: ok[\r\nauthorization: ]Bearer t0ken\r\n\r\n`))
        expect(reason(r)).toContain("x-note header value is partly revealed")
    })

    it("refuses a line that reveals bytes but hides its name", () => {
        expect(reason(parseAuthedRequest(transcript(`${GET}[authoriz]ation: Bearer x\r\n\r\n`)))).toContain(
            "hides its name",
        )
    })

    it("does not split lines at a hidden CRLF", () => {
        // The hidden span could be anything; the revealed tail must not
        // become a header line of its own.
        const r = parseAuthedRequest(transcript(`${GET}x-a: 1[\r\n]x-demos-bind: forged\r\n\r\n`))
        expect(reason(r)).toContain("x-a header value is partly revealed")
    })

    it("refuses a second request or a body after the headers", () => {
        expect(reason(parseAuthedRequest(transcript(`${GET}\r\n${GET}\r\n`)))).toContain("more than one")
        expect(reason(parseAuthedRequest(transcript(`${GET}\r\nbody`)))).toContain("more than one")
    })

    it("with allowBody, accepts one Content-Length body, hidden or revealed, that ends the transcript", () => {
        const POST = "POST /v1/data HTTP/1.1\r\nhost: api.example\r\n"
        const opts = { allowBody: true }
        expect(reason(parseAuthedRequest(transcript(`${POST}content-length: 7\r\n\r\n[{"a":1}]`), opts))).toBe(
            "accepted",
        )
        expect(reason(parseAuthedRequest(transcript(`${POST}content-length: 7\r\n\r\n{"a":1}`), opts))).toBe(
            "accepted",
        )
        expect(reason(parseAuthedRequest(transcript(`${GET}\r\n`), opts))).toBe("accepted")
    })

    it("with allowBody, refuses a second request, unframed, chunked or hidden-length bodies", () => {
        const POST = "POST /v1/data HTTP/1.1\r\nhost: api.example\r\n"
        const opts = { allowBody: true }
        const r = (marked: string) => reason(parseAuthedRequest(transcript(marked), opts))
        expect(r(`${POST}content-length: 2\r\n\r\nab${GET}\r\n`)).toContain("does not end")
        expect(r(`${POST}content-length: 9\r\n\r\nab`)).toContain("does not end")
        expect(r(`${GET}\r\n${GET}\r\n`)).toContain("does not end")
        expect(r(`${POST}transfer-encoding: chunked\r\n\r\n2\r\nab\r\n0\r\n\r\n`)).toContain(
            "not framed by Content-Length",
        )
        expect(r(`${POST}content-length: [2]\r\n\r\nab`)).toContain("not revealed")
        expect(r(`${POST}content-length: 2\r\ncontent-length: 2\r\n\r\nab`)).toContain("repeated")
        expect(r(`${POST}content-length: -2\r\n\r\n`)).toContain("malformed")
    })

    it("refuses a hidden end of headers, request line or other HTTP versions", () => {
        expect(reason(parseAuthedRequest(transcript(`${GET}[\r\n\r\n]`)))).toContain("no authenticated end")
        expect(reason(parseAuthedRequest(transcript("GET /[user] HTTP/1.1\r\n\r\n")))).toContain("not fully revealed")
        expect(reason(parseAuthedRequest(transcript("GET /user HTTP/1.0\r\n\r\n")))).toContain("not HTTP/1.1")
        expect(reason(parseAuthedRequest(transcript("GET  /user HTTP/1.1\r\n\r\n")))).toContain("malformed")
    })

    it("refuses too many header lines", () => {
        const many = Array.from({ length: 200 }, (_, i) => `x-${i}: v\r\n`).join("")
        expect(reason(parseAuthedRequest(transcript(`${GET}${many}\r\n`)))).toContain("too many")
    })
})

describe("singleHeader", () => {
    it("refuses a missing or repeated header", () => {
        const r = parseAuthedRequest(transcript(`${GET}host: other\r\n\r\n`))
        if (r.ok === false) throw new Error(r.reason)
        expect(reason(singleHeader(r.value.headers, "host"))).toContain("repeated")
        expect(reason(singleHeader(r.value.headers, "x-demos-bind"))).toContain("no revealed")
    })
})

const OK = "HTTP/1.1 200 OK\r\n"

describe("parseAuthedResponse", () => {
    it("reads a Content-Length body", () => {
        const r = parseAuthedResponse(transcript(`${OK}content-length: 7\r\n\r\n{"a":1}`))
        expect(body(r)).toBe("{\"a\":1}")
        expect(r.ok && r.value.status).toBe(200)
    })

    it("refuses a Content-Length that does not end the transcript", () => {
        expect(body(parseAuthedResponse(transcript(`${OK}content-length: 5\r\n\r\n{"a":1}`)))).toContain(
            "does not end",
        )
        expect(body(parseAuthedResponse(transcript(`${OK}content-length: 9\r\n\r\n{"a":1}`)))).toContain(
            "does not end",
        )
    })

    it("refuses a hidden or malformed Content-Length", () => {
        expect(body(parseAuthedResponse(transcript(`${OK}content-length: [7]\r\n\r\n{"a":1}`)))).toContain(
            "not revealed",
        )
        expect(body(parseAuthedResponse(transcript(`${OK}content-length: +7\r\n\r\n{"a":1}`)))).toContain(
            "not a length",
        )
    })

    it("decodes a chunked body without trailers", () => {
        const r = parseAuthedResponse(transcript(`${OK}transfer-encoding: chunked\r\n\r\n3\r\n{"a\r\n4\r\n":1}\r\n0\r\n\r\n`))
        expect(body(r)).toBe("{\"a\":1}")
    })

    it("refuses chunked bodies with trailers, hidden sizes or bytes after the end", () => {
        const te = `${OK}transfer-encoding: chunked\r\n\r\n`
        expect(body(parseAuthedResponse(transcript(`${te}2\r\n{}\r\n0\r\nx-t: 1\r\n\r\n`)))).toContain("does not end")
        expect(body(parseAuthedResponse(transcript(`${te}[2]\r\n{}\r\n0\r\n\r\n`)))).toContain("not revealed")
        expect(body(parseAuthedResponse(transcript(`${te}2;x=y\r\n{}\r\n0\r\n\r\n`)))).toContain("malformed chunk")
        expect(body(parseAuthedResponse(transcript(`${te}2\r\n{}\r\n0\r\n\r\nmore`)))).toContain("does not end")
        expect(body(parseAuthedResponse(transcript(`${te}9\r\n{}\r\n`)))).toContain("runs past")
        expect(body(parseAuthedResponse(transcript(`${te}2\r\n{}xx0\r\n\r\n`)))).toContain("not CRLF-terminated")
    })

    it("reads a body framed by the end of the connection", () => {
        expect(body(parseAuthedResponse(transcript(`${OK}connection: close\r\n\r\n{"a":1}`)))).toBe("{\"a\":1}")
    })

    it("refuses a body that is not fully revealed", () => {
        expect(body(parseAuthedResponse(transcript(`${OK}\r\n{"a":[1]}`)))).toContain("not fully revealed")
        expect(body(parseAuthedResponse(transcript(`${OK}content-length: 7\r\n\r\n{"a":[1]}`)))).toContain(
            "not fully revealed",
        )
        const te = `${OK}transfer-encoding: chunked\r\n\r\n`
        expect(body(parseAuthedResponse(transcript(`${te}2\r\n{[}]\r\n0\r\n\r\n`)))).toContain("not fully revealed")
    })

    it("refuses ambiguous framing and encoded bodies", () => {
        expect(
            body(parseAuthedResponse(transcript(`${OK}content-length: 2\r\ntransfer-encoding: chunked\r\n\r\n{}`))),
        ).toContain("both")
        expect(body(parseAuthedResponse(transcript(`${OK}content-length: 2\r\ncontent-length: 2\r\n\r\n{}`)))).toContain(
            "repeated",
        )
        expect(body(parseAuthedResponse(transcript(`${OK}content-encoding: gzip\r\n\r\n{}`)))).toContain("encoded")
        expect(body(parseAuthedResponse(transcript(`${OK}content-encoding: identity\r\n\r\n{}`)))).toBe("{}")
        expect(body(parseAuthedResponse(transcript(`${OK}transfer-encoding: gzip\r\n\r\n{}`)))).toContain(
            "unsupported",
        )
    })

    it("reads interim 1xx blocks as headers, not as the final body", () => {
        const r = parseAuthedResponse(
            transcript(`HTTP/1.1 103 Early Hints\r\nlink: </a.css>\r\n\r\nHTTP/1.1 100 Continue\r\n\r\n${OK}set-cookie: [s=1]\r\n\r\n{}`),
        )
        expect(r.ok && [r.value.status, r.value.interim.map(b => b.map(h => h.name)), r.value.headers]).toEqual([
            200,
            [["link"], []],
            [{ name: "set-cookie", value: null, valueRevealed: false }],
        ])
        expect(body(r)).toBe("{}")
    })

    it("refuses a protocol switch, a hidden interim block and endless interim blocks", () => {
        expect(body(parseAuthedResponse(transcript(`HTTP/1.1 101 Switching Protocols\r\n\r\n${OK}\r\n{}`)))).toContain(
            "switches protocols",
        )
        expect(body(parseAuthedResponse(transcript(`HTTP/1.1 103 [Early Hints]\r\n\r\n${OK}\r\n{}`)))).toContain(
            "status line is not fully revealed",
        )
        const hints = "HTTP/1.1 103 Early Hints\r\n\r\n".repeat(9)
        expect(body(parseAuthedResponse(transcript(`${hints}${OK}\r\n{}`)))).toContain("too many interim")
        expect(body(parseAuthedResponse(transcript("HTTP/1.1 103 Early Hints\r\n\r\n")))).toContain(
            "no authenticated end",
        )
    })

    it("reads the status of a refusing response, and refuses a hidden or malformed status line", () => {
        const r = parseAuthedResponse(transcript("HTTP/1.1 401 Unauthorized\r\n\r\n{}"))
        expect(r.ok && r.value.status).toBe(401)
        expect(body(parseAuthedResponse(transcript("HTTP/1.1 [200] OK\r\n\r\n{}")))).toContain("not fully revealed")
        expect(body(parseAuthedResponse(transcript("HTTP/1.0 200 OK\r\n\r\n{}")))).toContain("malformed status")
        expect(body(parseAuthedResponse(transcript(`${OK}x: y`)))).toContain("no authenticated end")
    })
})

describe("parseAuthedResponseHead", () => {
    it("reads the status and every header block, whatever the body reveals", () => {
        const r = parseAuthedResponseHead(
            transcript("HTTP/1.1 103 Early Hints\r\nlink: </a>\r\n\r\nHTTP/1.1 200 OK\r\nset-cookie: [s=1]\r\ncontent-length: 9\r\n\r\n{\"a\":[123]}"),
        )
        expect(r.ok).toBe(true)
        if (!r.ok) return
        expect(r.value.status).toBe(200)
        expect(r.value.interim.map(b => b.map(h => h.name))).toEqual([["link"]])
        expect(r.value.headers.map(h => [h.name, h.valueRevealed])).toEqual([
            ["set-cookie", false],
            ["content-length", true],
        ])
        // The same transcript is no response to read a body from.
        expect(parseAuthedResponse(transcript("HTTP/1.1 200 OK\r\ncontent-length: 3\r\n\r\n[abc]")).ok).toBe(false)
    })

    it("refuses a head whose status line or end is hidden", () => {
        expect(reason(parseAuthedResponseHead(transcript("HTTP/1.1 [200] OK\r\n\r\n")))).toContain("status line")
        expect(reason(parseAuthedResponseHead(transcript("HTTP/1.1 200 OK\r\nx: y[\r\n\r\n]")))).toContain("end of headers")
    })
})
