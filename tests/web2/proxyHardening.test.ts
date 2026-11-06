/**
 * The web2 (DAHR) proxy fetches URLs on behalf of any caller, so on a public
 * validator it must: listen only on loopback, stop reading an oversized origin
 * response, check certificates unless the operator set the dev flag, and
 * connect only to the address it checked (no DNS rebinding to a private one).
 */

import { afterAll, describe, expect, it, jest, mock } from "bun:test"
import http from "node:http"
import type { AddressInfo } from "node:net"

// Small cap so the test does not have to move megabytes.
process.env.WEB2_MAX_RESPONSE_BYTES = "1024"
delete process.env.WEB2_INSECURE_TLS

mock.module("@/utilities/sharedState", () => ({
    __esModule: true,
    default: { getInstance: () => ({ PROD: false }) },
}))
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
// The pre-connect check sees a public answer; the connection itself must not
// trust that answer (the rebinding case).
mock.module("node:dns/promises", () => ({
    __esModule: true,
    default: {
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    },
}))

const { Proxy } = await import("@/features/web2/proxy/Proxy")
const { Config } = await import("src/config")

const servers: http.Server[] = []
afterAll(() => {
    for (const s of servers) s.close()
})

function listen(
    handler: http.RequestListener,
    host = "127.0.0.1",
): Promise<number> {
    return new Promise(resolve => {
        const s = http.createServer(handler)
        servers.push(s)
        s.listen(0, host, () => resolve((s.address() as AddressInfo).port))
    })
}

function request(url: string) {
    return {
        web2Request: { raw: { url, headers: {} } } as any,
        targetMethod: "GET" as const,
        targetHeaders: {},
        payload: undefined,
        targetAuthorization: "",
    }
}

describe("web2 proxy hardening", () => {
    it("listens on loopback only", async () => {
        const proxy = new Proxy("session")
        await (proxy as any).startProxyServer("https://example.com/")
        try {
            const addr = (proxy as any)._server.address() as AddressInfo
            expect(addr.address).toBe("127.0.0.1")
        } finally {
            await proxy.stopProxy()
        }
    })

    it("refuses an origin response larger than the configured cap", async () => {
        const proxy = new Proxy("session")
        const big = "x".repeat(64 * 1024)
        const port = await listen((_req, res) => res.end(big))
        // Stand in for the local relay so the cap is exercised on its own.
        ;(proxy as any).startProxyServer = async () => {
            ;(proxy as any)._proxyPort = port
        }

        await expect(
            proxy.sendHTTPRequest(request("https://example.com/") as any),
        ).rejects.toThrow(/1024 bytes/)
    })

    it("does not hand back the origin's Set-Cookie, which the SDK would sign into the tx", async () => {
        const proxy = new Proxy("session")
        const port = await listen((_req, res) => {
            res.setHeader("Set-Cookie", "sid=secret; HttpOnly")
            res.setHeader("X-Kept", "yes")
            res.end("ok")
        })
        ;(proxy as any).startProxyServer = async () => {
            ;(proxy as any)._proxyPort = port
        }

        const result = await proxy.sendHTTPRequest(
            request("https://example.com/") as any,
        )
        expect(result.headers["set-cookie"]).toBeUndefined()
        expect(result.headers["x-kept"]).toBe("yes")
    })

    it("checks certificates unless the operator set the dev flag", () => {
        expect((new Proxy("session") as any)._sslConfig.verifyCertificates).toBe(
            true,
        )

        process.env.WEB2_INSECURE_TLS = "true"
        Config.resetInstance()
        try {
            expect(
                (new Proxy("session") as any)._sslConfig.verifyCertificates,
            ).toBe(false)
        } finally {
            delete process.env.WEB2_INSECURE_TLS
            Config.resetInstance()
        }
    })

    it("does not connect to a private address the pre-check never saw", async () => {
        let hits = 0
        const port = await listen((_req, res) => {
            hits++
            res.end("internal secret")
        })
        const proxy = new Proxy("session")
        try {
            const result = await proxy
                .sendHTTPRequest(request(`http://localhost:${port}/`) as any)
                .catch(e => ({ status: 0, data: String(e) }))
            expect(hits).toBe(0)
            expect(result.data).not.toContain("internal secret")
        } finally {
            await proxy.stopProxy()
        }
    })
})
