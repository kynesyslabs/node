import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import { BunServer, jsonResponse } from "../bunServer"
import { bodyLimit } from "./bodyLimit"

const PUBLIC_MAX = 1024
const PEER_MAX = 4096

let server: BunServer
let base: string
let parsedBodies = 0

beforeAll(() => {
    server = new BunServer(0, "127.0.0.1", { maxRequestBodySize: PEER_MAX })
    server.use(
        bodyLimit({
            maxBytes: PUBLIC_MAX,
            peerMaxBytes: PEER_MAX,
            isPeer: req => req.headers.get("x-peer") === "1",
        }),
    )
    server.post("/", async req => {
        const body = (await req.json()) as { pad: string }
        parsedBodies++
        return jsonResponse({ length: body.pad.length })
    })
    server.get("/ping", () => jsonResponse({ ok: true }))
    base = `http://127.0.0.1:${server.start().port}`
})

afterAll(() => {
    server.stop()
})

const post = (size: number, headers: Record<string, string> = {}) =>
    fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ pad: "x".repeat(size) }),
    })

describe("request body cap", () => {
    it("serves a body inside the public limit", async () => {
        const res = await post(100)
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ length: 100 })
    })

    it("refuses an oversized body before the handler parses it", async () => {
        const before = parsedBodies
        const res = await post(PUBLIC_MAX * 2)
        expect(res.status).toBe(413)
        expect(await res.json()).toEqual({
            error: "Request body too large",
            limit: PUBLIC_MAX,
        })
        expect(parsedBodies).toBe(before)
    })

    it("lets a trusted caller send up to the peer limit", async () => {
        const res = await post(PUBLIC_MAX * 2, { "x-peer": "1" })
        expect(res.status).toBe(200)
    })

    it("refuses a trusted caller past the peer limit", async () => {
        const before = parsedBodies
        const res = await post(PEER_MAX * 2, { "x-peer": "1" })
        expect(res.status).toBe(413)
        expect(parsedBodies).toBe(before)
    })

    it("turns away a body with no declared length instead of streaming it", async () => {
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('{"pad":"x"}'))
                controller.close()
            },
        })
        const res = await fetch(base, {
            method: "POST",
            body: stream,
            // Bun needs this to send a stream body.
            duplex: "half",
        } as RequestInit)
        expect(res.status).toBe(411)
    })

    it("does not touch requests that carry no body", async () => {
        const res = await fetch(`${base}/ping`)
        expect(res.status).toBe(200)
    })
})

describe("bodyLimit without the server ceiling", () => {
    const mw = bodyLimit({
        maxBytes: 10,
        peerMaxBytes: 20,
        isPeer: () => false,
    })
    const next = async () => new Response("ok")
    const req = (length: string) =>
        new Request("http://node/", {
            method: "POST",
            body: "x",
            headers: { "content-length": length },
        })

    it("rejects a malformed Content-Length", async () => {
        expect((await mw(req("abc"), next)).status).toBe(400)
        expect((await mw(req("-5"), next)).status).toBe(400)
    })

    it("does not offer the peer limit to a caller that is not trusted", async () => {
        expect((await mw(req("15"), next)).status).toBe(413)
        expect((await mw(req("10"), next)).status).toBe(200)
    })
})
