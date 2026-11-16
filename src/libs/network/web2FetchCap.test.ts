/**
 * `web2ProxyRequest` makes the node fetch a URL for anyone, unsigned and
 * free. One source must not be able to keep many of those fetches running or
 * start them without limit, while other sources are still served. Runs the
 * real RPC route: rate-limit middleware, client address resolution, dispatch
 * and the web2 handler; only the DAHR session (the actual outbound fetch) is
 * replaced.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test"
import { mockCore } from "src/utilities/testSupport/coreMocks"

const sharedState: Record<string, any> = {
    signingAlgorithm: "ed25519",
    lastBlockNumber: 10,
    keypair: { publicKey: new Uint8Array(32).fill(7) },
    publicKeyHex: "07".repeat(32),
    SUDO_PUBKEY: "",
    connectionString: "http://us:53550",
    serverPort: 0,
    PROD: false,
    rateLimitConfig: {
        enabled: true,
        defaultLimit: { maxRequests: 100_000, windowMs: 60_000 },
        blockDurationMs: 60_000,
        whitelistedIPs: ["127.0.0.1"],
        whitelistedKeys: [],
        methodLimits: {},
        txPerBlock: 1_000,
    },
}

mockCore(sharedState, { asInstance: true })
mock.module("src/model/datasource", () => ({
    __esModule: true,
    dataSource: {},
    default: {
        getInstance: async () => {
            throw new Error("no database in this test")
        },
    },
}))
mock.module("src/libs/consensus/stakedSet", () => ({
    getStakedSet: async () => new Set<string>(),
    getStakedSetHeight: () => 0,
    isStaked: async () => false,
    isSelfStaked: async () => false,
    onSelfStakeChange: () => () => undefined,
    invalidateStakedSet: () => undefined,
    __resetStakedSet: () => undefined,
}))

/** Each outbound fetch the node starts; `finish` ends it with `bytes` read. */
interface Started {
    sessionId: string
    finish: (bytes?: number) => void
}
const started: Started[] = []
let hang = false

function fakeDahr(sessionId: string) {
    return {
        sessionId,
        web2Request: { raw: { action: "startProxy", method: "GET", url: "https://example.com/", headers: {} } },
        startProxy: (params: { meter?: { bytes: number } }) =>
            new Promise(resolve => {
                const finish = (bytes = 2) => {
                    if (params?.meter) params.meter.bytes += bytes
                    resolve({ status: 200, statusText: "OK", headers: {}, data: "ok" })
                }
                started.push({ sessionId, finish })
                if (!hang) finish()
            }),
        toSerializable: () => ({ sessionId }),
    }
}
mock.module("src/features/web2/dahr/DAHRFactory", () => ({
    DAHRFactory: {
        instance: {
            getDAHR: (sessionId: string) => fakeDahr(sessionId),
            createDAHR: async () => fakeDahr("created"),
        },
    },
}))

const { BunServer } = await import("./bunServer")
BunServer.prototype.start = function () {
    return null as any
}
const { serverRpcBun } = await import("./server_rpc")

const server: any = await serverRpcBun()
// The socket peer is read from a test header, so each request can come from
// its own address.
const fakeServer = {
    requestIP: (req: Request) => ({ address: req.headers.get("x-test-socket-ip") ?? "198.51.100.1" }),
}
server.server = fakeServer

function web2Body(sessionId: string): string {
    return JSON.stringify({
        method: "web2ProxyRequest",
        params: [
            {
                message: {
                    sessionId,
                    payload: null,
                    authorization: "",
                    web2Request: {
                        raw: { action: "startProxy", method: "GET", url: "https://example.com/", headers: {} },
                    },
                },
            },
        ],
    })
}

async function web2From(ip: string, sessionId: string, headers: Record<string, string> = {}) {
    const body = web2Body(sessionId)
    const req = new Request("http://node/", {
        method: "POST",
        body,
        headers: {
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(body)),
            "x-test-socket-ip": ip,
            ...headers,
        },
    })
    const res: Response = await server.handleRequest(req, fakeServer)
    return (await res.json()) as { result: number; response: any; extra: any }
}

/** Lets queued requests reach the fetch before the test looks. */
const settle = () => new Promise(r => setTimeout(r, 20))

/** A reply that should come at once, or a marker saying it is still running. */
function promptly<T>(p: Promise<T>): Promise<T | { result: "still running" }> {
    return Promise.race([p, new Promise<{ result: "still running" }>(r => setTimeout(() => r({ result: "still running" }), 500))])
}

beforeEach(() => {
    started.length = 0
    hang = false
})

describe("web2ProxyRequest per-caller cap", () => {
    it("refuses a source's third concurrent fetch with 429 while another source is served", async () => {
        hang = true
        const ip = "203.0.113.10"
        const first = web2From(ip, "s1")
        const second = web2From(ip, "s2")
        await settle()
        const third: any = await promptly(web2From(ip, "s3"))

        expect(third.result).toBe(429)
        expect(third.response).toMatchObject({ error: "WEB2_FETCH_LIMITED", reason: "caller-inflight" })
        expect(third.response.retryAfterSeconds).toBeGreaterThanOrEqual(1)
        expect(typeof third.extra).toBe("string")
        expect(third.extra).not.toContain("    at ")
        expect(started.map(s => s.sessionId)).toEqual(["s1", "s2"])

        const other = web2From("203.0.113.11", "o1")
        await settle()
        expect(started.map(s => s.sessionId)).toEqual(["s1", "s2", "o1"])

        for (const s of started) s.finish()
        expect((await first).result).toBe(200)
        expect((await second).result).toBe(200)
        expect((await other).result).toBe(200)

        // A finished fetch gives its slot back.
        hang = false
        expect((await web2From(ip, "s4")).result).toBe(200)
    })

    it("refuses a source's 11th fetch within a minute while another source is served", async () => {
        const ip = "203.0.113.20"
        for (let i = 1; i <= 10; i++) {
            const reply = await web2From(ip, `r${i}`)
            expect([i, reply.result]).toEqual([i, 200])
        }
        const eleventh = await web2From(ip, "r11")
        expect(eleventh.result).toBe(429)
        expect(eleventh.response).toMatchObject({ error: "WEB2_FETCH_LIMITED", reason: "caller-rate" })
        expect(eleventh.response.retryAfterSeconds).toBeGreaterThanOrEqual(1)
        expect(started.map(s => s.sessionId)).not.toContain("r11")

        expect((await web2From("203.0.113.21", "q1")).result).toBe(200)
    })

    it("does not let a source escape its cap with a forged X-Forwarded-For", async () => {
        hang = true
        const ip = "203.0.113.30"
        const held = [web2From(ip, "x1"), web2From(ip, "x2")]
        await settle()
        const spoofed: any = await promptly(
            web2From(ip, "x3", {
                "X-Forwarded-For": "192.0.2.77",
                "X-Real-IP": "192.0.2.78",
            }),
        )
        expect(spoofed.result).toBe(429)
        expect(spoofed.response.reason).toBe("caller-inflight")
        for (const s of started) s.finish()
        await Promise.all(held)
    })

    it("counts every address of one IPv6 /64 as one source", async () => {
        hang = true
        const held = [web2From("2001:db8:1:2::a", "v1"), web2From("2001:db8:1:2::b", "v2")]
        await settle()
        const third = await promptly(web2From("2001:db8:1:2::c", "v3"))
        expect(third.result).toBe(429)
        for (const s of started) s.finish()
        await Promise.all(held)
    })

    it("lets a whitelisted address past the per-source cap", async () => {
        hang = true
        const held = [1, 2, 3, 4].map(i => web2From("127.0.0.1", `l${i}`))
        await settle()
        expect(started.map(s => s.sessionId)).toEqual(["l1", "l2", "l3", "l4"])
        for (const s of started) s.finish()
        for (const r of await Promise.all(held)) expect(r.result).toBe(200)
    })
})
