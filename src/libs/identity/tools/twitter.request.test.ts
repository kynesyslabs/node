import { afterEach, describe, expect, it, mock } from "bun:test"
import { readFileSync } from "node:fs"
import { createServer, type RequestListener, type Server } from "node:http"
import { IDENTITY_ADMISSION_TIMEOUT_MS } from "@/libs/blockchain/validation/identityAdmission"

mock.module("@/utilities/logger", () => ({
    default: { debug: () => {}, info: () => {}, error: () => {}, warn: () => {} },
}))

const { Twitter } = await import("./twitter")

const servers: Server[] = []

async function serve(
    respond: RequestListener,
): Promise<string> {
    const server = createServer(respond)
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("No test port")
    return `http://127.0.0.1:${address.port}`
}

afterEach(async () => {
    for (const server of servers.splice(0)) {
        server.closeAllConnections()
        await new Promise<void>(resolve => server.close(() => resolve()))
    }
})

describe("Twitter provider reads", () => {
    it("rejects a missing RapidAPI key before making a request", async () => {
        let requests = 0
        const url = await serve((_req, res) => {
            requests++
            res.end("{}")
        })
        const twitter = new Twitter()
        twitter.api_key = ""

        await expect(twitter.makeRequest(`${url}/tweet.php?id=1`)).rejects.toThrow(
            "RAPID_API_KEY is not set",
        )
        expect(requests).toBe(0)
    })

    it("aborts a stalled partial response before admission times out", async () => {
        const guardMs = IDENTITY_ADMISSION_TIMEOUT_MS + 200
        const url = await serve((_req, res) => {
            res.writeHead(200, { "Content-Type": "application/json" })
            res.write("{\"partial\":")
        })
        const started = Date.now()
        let timer: ReturnType<typeof setTimeout> | undefined
        const twitter = new Twitter()
        twitter.api_key = "test-key"
        const outcome = await Promise.race([
            twitter.makeRequest(`${url}/tweet.php?id=1`).then(
                () => null,
                error => error,
            ),
            new Promise<Error>(resolve => {
                timer = setTimeout(() => resolve(new Error("request still pending")), guardMs)
            }),
        ])
        clearTimeout(timer)

        expect(outcome).toMatchObject({
            message: `Web2 request did not complete within ${IDENTITY_ADMISSION_TIMEOUT_MS - 500} ms`,
        })
        expect(Date.now() - started).toBeLessThan(IDENTITY_ADMISSION_TIMEOUT_MS)
    }, 10_000)

    it("propagates a stalled follow request error", async () => {
        const url = await serve((_req, res) => {
            res.writeHead(200, { "Content-Type": "application/json" })
            res.write("{\"partial\":")
        })
        const twitter = new Twitter()
        twitter.api_key = "test-key"
        twitter.api_url = url
        twitter.setLimits({ timeoutMs: 50, maxBytes: 4 * 1024 * 1024 })

        await expect(twitter.checkFollow("someone")).rejects.toThrow(
            "Web2 request did not complete within 50 ms",
        )
    }, 10_000)

    it("rejects an oversized provider response", async () => {
        const url = await serve((_req, res) => {
            res.writeHead(200, { "Content-Type": "application/json" })
            res.end(Buffer.alloc(4 * 1024 * 1024 + 1, "x"))
        })
        const twitter = new Twitter()
        twitter.api_key = "test-key"

        await expect(twitter.makeRequest(`${url}/timeline.php`)).rejects.toThrow(
            "Web2 response exceeds 4194304 bytes",
        )
    })

    it("uses a smaller web2 response cap", async () => {
        const url = await serve((_req, res) => {
            res.writeHead(200, { "Content-Type": "application/json" })
            res.end(Buffer.alloc(1024 + 1, "x"))
        })
        const twitter = new Twitter()
        twitter.api_key = "test-key"
        twitter.setLimits({ timeoutMs: 30_000, maxBytes: 1024 })

        await expect(twitter.makeRequest(`${url}/timeline.php`)).rejects.toThrow(
            "Web2 response exceeds 1024 bytes",
        )
    })

    it("documents the read caps and key check in the upgrade notes", () => {
        const runbook = readFileSync(
            new URL("../../../../docs/runbooks/release.md", import.meta.url),
            "utf8",
        )
        const note = runbook
            .split("- From `v1.0.0-rc.12`:")[1]
            ?.split("\n## ")[0]
            .replace(/\s+/g, " ")
        expect(note).toContain("capped at 4.5 s")
        expect(note).toContain("at most 4 MiB, or `WEB2_MAX_RESPONSE_BYTES` if that is smaller")
        expect(note).toContain("A missing `RAPID_API_KEY` is now refused before any request is sent.")
    })
})
