/**
 * A web2 request must end within its deadline even when the other side keeps
 * the connection busy. The socket idle timeout alone never fires on a slow
 * trickle, so a request could hold a DAHR session (and the caller's RPC) for
 * minutes: the rc.8 rehearsal measured 202 s for a 1.25 MB origin.
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

/** A relay that answers 200 and then sends one byte every 50 ms, forever. */
async function tricklingRelay(): Promise<number> {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" })
        timers.push(setInterval(() => res.write("x"), 50))
    })
    servers.push(server)
    await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()))
    return (server.address() as AddressInfo).port
}

/** A Proxy pointed at `port` as its already-running relay. */
function proxyOnRelay(port: number, deadlineMs: number) {
    const proxy = new Proxy(
        "test-session",
        "127.0.0.1",
        { requireAuthForAll: false, exceptions: [] },
        { verifyCertificates: true },
        10 * 1024 * 1024,
        deadlineMs,
    ) as any
    proxy._isInitialized = true
    proxy._proxyPort = port
    proxy._currentTargetUrl = "https://example.com/slow"
    return proxy
}

const params = {
    web2Request: { raw: { url: "https://example.com/slow" } },
    targetMethod: "GET",
    targetHeaders: {},
    payload: null,
    targetAuthorization: "",
} as any

describe("web2 request deadline", () => {
    it("rejects a response still trickling at the deadline", async () => {
        const port = await tricklingRelay()
        const proxy = proxyOnRelay(port, 400)
        const started = Date.now()

        const outcome = await Promise.race([
            proxy.sendHTTPRequest(params).then(
                () => "resolved",
                (e: Error) => e.message,
            ),
            new Promise(r => setTimeout(() => r("still running"), 3000)),
        ])

        expect(outcome).toContain("did not complete within 400 ms")
        expect(Date.now() - started).toBeLessThan(2000)
    })

    it("passes the deadline to the relay as its origin timeout", () => {
        const proxy = proxyOnRelay(1, 1234)
        expect(proxy.relayOptions("https://example.com/").proxyTimeout).toBe(
            1234,
        )
        expect(proxy.relayOptions("https://example.com/").timeout).toBe(1234)
    })
})
