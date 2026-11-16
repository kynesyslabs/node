/**
 * A caller's Content-Type must reach the origin as sent, whatever its letter
 * case. The relay adds `application/json` only when the caller set none;
 * adding it next to a caller's `content-type` replaced the caller's value.
 */

import { afterEach, describe, expect, it, mock } from "bun:test"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { mockLogger } from "src/utilities/testSupport/coreMocks"

// The origin under test listens on loopback, which the relay refuses by design.
const allowLoopback = () => ({
    __esModule: true,
    isPublicAddress: () => true,
    publicOnlyLookup: undefined,
})
// The relay's modules import these by both specifiers.
for (const root of ["@/utilities", "src/utilities"]) {
    mockLogger(`${root}/logger`)
    mock.module(`${root}/outboundAddress`, allowLoopback)
}
mock.module("@/utilities/sharedState", () => ({
    __esModule: true,
    default: { getInstance: () => ({ PROD: false }) },
}))

const { Proxy } = await import("./Proxy")

const servers: http.Server[] = []
const proxies: any[] = []

afterEach(async () => {
    for (const p of proxies.splice(0)) {
        p._server?.closeAllConnections?.()
        await p.stopProxy()
    }
    for (const s of servers.splice(0)) {
        s.closeAllConnections?.()
        s.close()
    }
})

/** An origin that answers with the Content-Type headers it received. */
async function echoingOrigin(): Promise<string> {
    const server = http.createServer((req, res) => {
        const values: string[] = []
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
            if (req.rawHeaders[i].toLowerCase() === "content-type") {
                values.push(req.rawHeaders[i + 1])
            }
        }
        req.resume()
        req.on("end", () => {
            res.writeHead(200, { "Content-Type": "application/json" })
            res.end(JSON.stringify(values))
        })
    })
    servers.push(server)
    await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()))
    const { port } = server.address() as AddressInfo
    return `http://127.0.0.1:${port}/echo`
}

async function contentTypesAtOrigin(
    targetHeaders: Record<string, string>,
): Promise<string[]> {
    const url = await echoingOrigin()
    const proxy = new Proxy(
        "test-session",
        "127.0.0.1",
        { requireAuthForAll: false, exceptions: [] },
        { verifyCertificates: true },
        10 * 1024 * 1024,
        5_000,
    ) as any
    proxies.push(proxy)
    const result = await proxy.sendHTTPRequest({
        web2Request: { raw: { url } },
        targetMethod: "POST",
        targetHeaders,
        payload: "a=1",
        targetAuthorization: "",
    })
    expect(result.status).toBe(200)
    return JSON.parse(result.data)
}

describe("web2 relay Content-Type", () => {
    for (const [name, value] of [
        ["content-type", "text/plain"],
        ["CONTENT-TYPE", "application/xml"],
        ["Content-type", "application/x-www-form-urlencoded"],
        ["Content-Type", "text/csv"],
    ]) {
        it(`keeps a caller's ${name} header unchanged`, async () => {
            expect(await contentTypesAtOrigin({ [name]: value })).toEqual([value])
        })
    }

    it("sends application/json when the caller sets no Content-Type", async () => {
        expect(await contentTypesAtOrigin({})).toEqual(["application/json"])
    })
})
