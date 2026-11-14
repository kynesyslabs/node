/**
 * A caller's web2 byte budget is charged with what the node actually read
 * from the origin. A response refused for its size, or cut at the deadline,
 * was still downloaded, so it must be counted too, or an oversized target
 * would cost its caller nothing.
 */

import { afterEach, describe, expect, it, jest, mock } from "bun:test"
import http from "node:http"
import type { AddressInfo } from "node:net"

const quietLog = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
    only: jest.fn(),
}
mock.module("@/utilities/logger", () => ({ __esModule: true, default: quietLog }))
mock.module("src/utilities/logger", () => ({ __esModule: true, default: quietLog }))
mock.module("@/utilities/sharedState", () => ({
    __esModule: true,
    default: { getInstance: () => ({ PROD: false }) },
}))

const { Proxy } = await import("./Proxy")

const servers: http.Server[] = []
const timers: ReturnType<typeof setInterval>[] = []

afterEach(() => {
    for (const t of timers.splice(0)) clearInterval(t)
    for (const s of servers.splice(0)) s.close()
})

async function relay(handler: http.RequestListener): Promise<number> {
    const server = http.createServer(handler)
    servers.push(server)
    await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()))
    return (server.address() as AddressInfo).port
}

function proxyOnRelay(port: number, maxBytes: number, deadlineMs = 5_000) {
    const proxy = new Proxy(
        "test-session",
        "127.0.0.1",
        { requireAuthForAll: false, exceptions: [] },
        { verifyCertificates: true },
        maxBytes,
        deadlineMs,
    ) as any
    proxy._isInitialized = true
    proxy._proxyPort = port
    proxy._currentTargetUrl = "https://example.com/data"
    return proxy
}

const params = {
    web2Request: { raw: { url: "https://example.com/data" } },
    targetMethod: "GET",
    targetHeaders: {},
    payload: null,
    targetAuthorization: "",
} as any

describe("web2 response byte meter", () => {
    it("counts the bytes of a delivered response", async () => {
        const port = await relay((_req, res) => {
            res.writeHead(200, { "Content-Type": "text/plain" })
            res.end("x".repeat(1_000))
        })
        const meter = { bytes: 0 }
        const result = await proxyOnRelay(port, 10_000).sendHTTPRequest(params, meter)
        expect(result.data.length).toBe(1_000)
        expect(meter.bytes).toBe(1_000)
    })

    it("counts the bytes read before a response is refused for its size", async () => {
        const port = await relay((_req, res) => {
            res.writeHead(200, { "Content-Type": "text/plain" })
            res.end("x".repeat(50_000))
        })
        const meter = { bytes: 0 }
        await expect(proxyOnRelay(port, 1_000).sendHTTPRequest(params, meter)).rejects.toThrow(
            "exceeds 1000 bytes",
        )
        expect(meter.bytes).toBeGreaterThan(1_000)
    })

    it("counts the bytes read before the deadline cut", async () => {
        const port = await relay((_req, res) => {
            res.writeHead(200, { "Content-Type": "text/plain" })
            timers.push(setInterval(() => res.write("y".repeat(100)), 20))
        })
        const meter = { bytes: 0 }
        await expect(proxyOnRelay(port, 1_000_000, 300).sendHTTPRequest(params, meter)).rejects.toThrow(
            "did not complete within 300 ms",
        )
        expect(meter.bytes).toBeGreaterThan(0)
    })
})
