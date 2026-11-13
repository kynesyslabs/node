/**
 * The GitHub (Octokit) and RapidAPI (Twitter) lookups behind web2 identity
 * verification give up at a deadline that covers the body, and refuse a
 * response over the size cap, against a local origin that trickles or
 * oversends. The clients are the real ones.
 */

import { afterAll, describe, expect, it } from "bun:test"

// Read when the config first loads, so set before the modules are imported.
process.env.GITHUB_TOKEN ||= "test-token"

const { boundedFetch } = await import("./boundedFetch")
const { GithubProofParser } = await import("./github")
const { Twitter } = await import("src/libs/identity/tools/twitter")

const LIMITS = { timeoutMs: 300, maxBytes: 1024 }
const enc = new TextEncoder()

const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
        const path = new URL(req.url).pathname
        if (path.endsWith("/trickle")) {
            // Headers at once, then one byte every 50 ms for ever.
            let timer: ReturnType<typeof setInterval>
            return new Response(
                new ReadableStream({
                    start(c) {
                        c.enqueue(enc.encode("{"))
                        timer = setInterval(() => {
                            try {
                                c.enqueue(enc.encode(" "))
                            } catch {
                                clearInterval(timer)
                            }
                        }, 50)
                    },
                    cancel() {
                        clearInterval(timer)
                    },
                }),
                { headers: { "content-type": "application/json" } },
            )
        }
        if (path.endsWith("/big")) {
            return Response.json({ pad: "x".repeat(4096) })
        }
        if (path.endsWith("/chunked")) {
            // No content-length: the cap has to hold while reading.
            return new Response(
                new ReadableStream({
                    pull(c) {
                        c.enqueue(enc.encode("x".repeat(512)))
                    },
                }),
                { headers: { "content-type": "application/json" } },
            )
        }
        if (path.endsWith("/missing")) return new Response("not found", { status: 404 })
        return Response.json({ is_follow: true, owner: { login: "a", id: 1 } })
    },
})
const base = `http://127.0.0.1:${server.port}`
afterAll(() => server.stop(true))

const elapsed = async (p: Promise<unknown>) => {
    const t0 = Date.now()
    const err = await p.then(
        () => null,
        (e: unknown) => e as Error,
    )
    return { err, ms: Date.now() - t0 }
}

describe("boundedFetch", () => {
    const get = boundedFetch(LIMITS)

    it("returns a response within the limits", async () => {
        const res = await get(`${base}/ok`)
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ is_follow: true, owner: { login: "a", id: 1 } })
    })

    it("gives up at the deadline while the origin keeps trickling", async () => {
        const { err, ms } = await elapsed(get(`${base}/trickle`))
        expect(err?.message).toBe("Web2 request did not complete within 300 ms")
        expect(ms).toBeLessThan(2_000)
    })

    it("refuses a body over the cap, declared or streamed", async () => {
        for (const path of ["/big", "/chunked"]) {
            const { err } = await elapsed(get(`${base}${path}`))
            expect(err?.message).toBe("Web2 response exceeds 1024 bytes")
        }
    })
})

describe("GitHub gist lookup", () => {
    const octokit = async () => {
        const parser = new GithubProofParser()
        await parser.login(LIMITS)
        return (parser as any).github as { request: (r: string, o: object) => Promise<any> }
    }

    it("reads a gist within the limits", async () => {
        const res = await (await octokit()).request("GET /gists/{id}", { id: "ok", baseUrl: base })
        expect(res.data.owner.login).toBe("a")
    })

    it("gives up at the deadline and refuses an oversized response", async () => {
        const github = await octokit()
        const slow = await elapsed(github.request("GET /gists/{id}", { id: "trickle", baseUrl: base }))
        expect(slow.err?.message).toContain("did not complete within 300 ms")
        expect(slow.ms).toBeLessThan(2_000)

        const big = await elapsed(github.request("GET /gists/{id}", { id: "chunked", baseUrl: base }))
        expect(big.err?.message).toContain("exceeds 1024 bytes")
    })
})

describe("RapidAPI (Twitter) lookup", () => {
    const twitter = () => {
        const t = new Twitter()
        t.setLimits(LIMITS)
        return t
    }

    it("reads a response within the limits", async () => {
        const res = await twitter().makeRequest<{ is_follow: boolean }>(`${base}/ok`)
        expect(res.status).toBe(200)
        expect(res.data.is_follow).toBe(true)
    })

    it("gives up at the deadline and refuses an oversized response", async () => {
        const slow = await elapsed(twitter().makeRequest(`${base}/trickle`))
        expect(slow.err?.message).toBe("Web2 request did not complete within 300 ms")
        expect(slow.ms).toBeLessThan(2_000)

        const big = await elapsed(twitter().makeRequest(`${base}/chunked`))
        expect(big.err?.message).toBe("Web2 response exceeds 1024 bytes")
    })

    it("treats a non-2xx answer as a failed request, as before", async () => {
        const { err } = await elapsed(twitter().makeRequest(`${base}/missing`))
        expect(err?.message).toBe("Request failed with status code 404")
    })
})
