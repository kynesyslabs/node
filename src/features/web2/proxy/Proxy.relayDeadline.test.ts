/**
 * The relay must drop its outbound origin connection at the request deadline,
 * not only answer the caller. An idle timeout never fires while the origin
 * keeps trickling bytes, and a free proxy session could otherwise hold node
 * sockets open for as long as a slow origin likes.
 */

import { afterEach, describe, expect, it, jest, mock } from "bun:test"
import http from "node:http"
import type { AddressInfo, Socket } from "node:net"

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
// The origin under test listens on loopback, which the relay refuses by design.
const allowLoopback = () => ({
    __esModule: true,
    isPublicAddress: () => true,
    publicOnlyLookup: undefined,
})
mock.module("src/utilities/outboundAddress", allowLoopback)
mock.module("@/utilities/outboundAddress", allowLoopback)

const { Proxy } = await import("./Proxy")

const servers: http.Server[] = []
const timers: ReturnType<typeof setInterval>[] = []
const proxies: any[] = []

afterEach(async () => {
    for (const t of timers.splice(0)) clearInterval(t)
    for (const p of proxies.splice(0)) {
        p._server?.closeAllConnections?.()
        void p.stopProxy()
    }
    for (const s of servers.splice(0)) {
        s.closeAllConnections?.()
        s.close()
    }
})

interface TricklingOrigin {
    url: string
    /** Resolves when the origin's socket for the request closes. */
    closed: Promise<void>
    requested: Promise<void>
}

/** An origin that sends headers and then one byte every 50 ms, forever. */
async function tricklingOrigin(): Promise<TricklingOrigin> {
    let onClosed!: () => void
    let onRequested!: () => void
    const closed = new Promise<void>(r => (onClosed = r))
    const requested = new Promise<void>(r => (onRequested = r))
    const server = http.createServer((req, res) => {
        onRequested()
        const socket: Socket = req.socket
        socket.on("close", () => onClosed())
        res.writeHead(200, { "Content-Type": "text/plain" })
        timers.push(
            setInterval(() => {
                if (!socket.destroyed) res.write("x")
            }, 50),
        )
    })
    servers.push(server)
    await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()))
    const { port } = server.address() as AddressInfo
    return { url: `http://127.0.0.1:${port}/slow`, closed, requested }
}

function relay(deadlineMs: number) {
    const proxy = new Proxy(
        "test-session",
        "127.0.0.1",
        { requireAuthForAll: false, exceptions: [] },
        { verifyCertificates: true },
        10 * 1024 * 1024,
        deadlineMs,
    ) as any
    proxies.push(proxy)
    return proxy
}

function paramsFor(url: string) {
    return {
        web2Request: { raw: { url } },
        targetMethod: "GET",
        targetHeaders: {},
        payload: null,
        targetAuthorization: "",
    } as any
}

const timeout = <T>(ms: number, value: T) =>
    new Promise<T>(r => setTimeout(() => r(value), ms))

describe("web2 relay deadline", () => {
    it("closes the origin connection at the request deadline", async () => {
        const deadlineMs = 400
        const origin = await tricklingOrigin()
        const proxy = relay(deadlineMs)

        const outcome = proxy.sendHTTPRequest(paramsFor(origin.url)).then(
            () => "resolved",
            (e: Error) => e.message,
        )
        await origin.requested

        expect(await outcome).toContain(`did not complete within ${deadlineMs} ms`)
        const originSocket = await Promise.race([
            origin.closed.then(() => "closed"),
            timeout(deadlineMs + 1000, "still open after deadline + 1 s"),
        ])
        expect(originSocket).toBe("closed")
    })

    it("closes the origin connection when the caller goes away early", async () => {
        const origin = await tricklingOrigin()
        const proxy = relay(5000)
        await proxy.createNewServer(origin.url)

        const caller = http.request({
            hostname: "127.0.0.1",
            port: proxy._proxyPort,
            path: "/",
        })
        caller.on("error", () => {})
        const gotHeaders = new Promise<void>(r => caller.on("response", () => r()))
        caller.end()
        await gotHeaders
        caller.destroy()

        const originSocket = await Promise.race([
            origin.closed.then(() => "closed"),
            timeout(1500, "still open 1.5 s after the caller left"),
        ])
        expect(originSocket).toBe("closed")
    })

    it("does not hold the next target behind a request still trickling", async () => {
        const slow = await tricklingOrigin()
        const fast = http.createServer((_req, res) => res.end("ok"))
        servers.push(fast)
        await new Promise<void>(r => fast.listen(0, "127.0.0.1", () => r()))
        const fastUrl = `http://127.0.0.1:${(fast.address() as AddressInfo).port}/`
        const proxy = relay(5000)

        const first = proxy.sendHTTPRequest(paramsFor(slow.url)).catch(
            (e: Error) => e.message,
        )
        await slow.requested

        const second = await Promise.race([
            proxy.sendHTTPRequest(paramsFor(fastUrl)).then(
                (r: { data: string }) => r.data,
                (e: Error) => e.message,
            ),
            timeout(1500, "next request still waiting after 1.5 s"),
        ])
        expect(second).toBe("ok")
        await first
    })
})
