import { afterEach, describe, expect, it, mock } from "bun:test"
import fs from "node:fs"
import path from "node:path"

mock.module("./authContext", () => ({
    getAuthContext: () => ({
        verified: false,
        identity: null,
        publicKey: null,
        algorithm: null,
    }),
    setAuthContext: mock(() => undefined),
}))

mock.module("@/libs/peer", () => ({
    PeerManager: { getInstance: () => ({ getPeer: () => undefined }) },
}))

mock.module("@/libs/consensus/stakedSet", () => ({
    getStakedSet: async () => new Set<string>(),
}))

mock.module("@/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: {
        getGCRValidatorsAtBlock: async () => [],
        getGCRValidatorsAtBlockOrThrow: async () => [],
    },
}))

mock.module("@kynesyslabs/demosdk/encryption", () => ({
    uint8ArrayToHex: (value: Uint8Array) => Buffer.from(value).toString("hex"),
    hexToUint8Array: (value: string) =>
        Uint8Array.from(Buffer.from(value, "hex")),
    ucrypto: { verify: async () => true },
}))

mock.module("@/utilities/sharedState", () => ({
    getSharedState: {
        keypair: { publicKey: Uint8Array.from([0xaa]) },
        lastBlockNumber: 7,
    },
}))

const { RateLimiter } = await import("./middleware/rateLimiter")
const { handleIdentityTxRateLimit } = await import("./rpcRateLimit")
const { LOCALHOST_IPS } = await import("@/utilities/constants")

type Limiter = InstanceType<typeof RateLimiter>

const limiters: Limiter[] = []

// The whitelist is built the way sharedState builds it: the built-in
// loopback list plus whatever the operator adds.
function build(
    opts: { xffMode?: "off" | "strict" | "legacy"; trustedProxies?: string[]; extra?: string[] } = {},
): Limiter {
    const limiter = new RateLimiter({
        enabled: true,
        defaultLimit: { maxRequests: 2, windowMs: 60_000 },
        blockDurationMs: 60_000,
        whitelistedIPs: [...LOCALHOST_IPS, ...(opts.extra ?? [])],
        whitelistedKeys: [],
        methodLimits: {},
        txPerBlock: 4,
        xffMode: opts.xffMode,
        trustedProxies: opts.trustedProxies,
    })
    limiters.push(limiter)
    return limiter
}

function server(socketIp: string) {
    return {
        requestIP: () => ({ address: socketIp, port: 0 }),
    } as unknown as Parameters<Limiter["getClientIP"]>[1]
}

function isLocal(
    limiter: Limiter,
    socketIp: string,
    headers: Record<string, string> = {},
): boolean {
    const req = new Request("http://localhost/", { headers })
    const ip = limiter.getClientIP(req, server(socketIp))
    return limiter.isTrustedInternalRequest(req, ip)
}

afterEach(() => {
    for (const l of limiters.splice(0)) l.destroy()
})

describe("loopback whitelist", () => {
    it.each([
        "127.0.0.1",
        "::1",
        "0:0:0:0:0:0:0:1",
        "::ffff:127.0.0.1",
        "::ffff:7f00:1",
        "[::1]:5000",
        // The whole of 127.0.0.0/8 is loopback, not only 127.0.0.1: a local
        // client that binds its source address to another 127/8 address
        // (for example `curl --interface 127.0.0.2`, or a sidecar bound to
        // 127.0.0.6) is local too. A client that only dials another 127/8
        // address is seen as 127.0.0.1 on Linux and was already local.
        "127.0.0.2",
        "127.1.2.3",
        "127.255.255.254",
        "::ffff:127.0.0.2",
    ])("treats %s as local", addr => {
        expect(isLocal(build(), addr)).toBe(true)
    })

    it.each([
        "126.255.255.255",
        "128.0.0.1",
        "10.0.0.1",
        "172.17.0.1",
        "::2",
        "::",
        "::ffff:10.0.0.1",
        "2001:db8::1",
        "unknown",
        "localhost",
    ])("does not treat %s as local", addr => {
        expect(isLocal(build(), addr)).toBe(false)
    })

    it("does not let a remote peer pass as local through proxy headers", () => {
        const headers = {
            "x-forwarded-for": "127.0.0.1",
            "x-real-ip": "::1",
            "cf-connecting-ip": "127.0.0.2",
        }
        for (const xffMode of ["off", "strict"] as const) {
            expect(isLocal(build({ xffMode }), "203.0.113.9", headers)).toBe(false)
        }
    })

    it("does not let an untrusted peer's forwarded loopback address through", () => {
        const limiter = build({ xffMode: "strict", trustedProxies: ["10.0.0.0/8"] })
        expect(
            isLocal(limiter, "203.0.113.9", { "x-forwarded-for": "127.0.0.2" }),
        ).toBe(false)
    })

    it("takes a loopback header value as the client's address in no spelling in legacy mode", () => {
        const limiter = build({ xffMode: "legacy" })
        for (const value of [
            "127.0.0.2",
            "0:0:0:0:0:0:0:1",
            "::ffff:7f00:1",
            "[127.0.0.1:80]",
        ]) {
            expect(
                isLocal(limiter, "203.0.113.9", { "x-forwarded-for": value }),
            ).toBe(false)
            expect(
                isLocal(limiter, "203.0.113.9", { "x-real-ip": value }),
            ).toBe(false)
        }
    })

    it("does not take an over-long header value that normalises to loopback as the client's address in legacy mode", () => {
        const limiter = build({ xffMode: "legacy" })
        for (const value of [
            "0x" + "0".repeat(60) + "7f.0.0.2",
            "[::1]" + "0".repeat(60),
            "127.0.0.2:" + "9".repeat(60),
        ]) {
            expect(value.length).toBeGreaterThan(64)
            expect(
                isLocal(limiter, "203.0.113.9", { "x-forwarded-for": value }),
            ).toBe(false)
            expect(
                isLocal(limiter, "203.0.113.9", { "x-real-ip": value }),
            ).toBe(false)
        }
    })

    it("does not treat a value longer than 64 characters as loopback", () => {
        const limiter = build()
        expect(limiter.isWhitelistedIP("[::1]")).toBe(true)
        expect(limiter.isWhitelistedIP("[::1]" + "0".repeat(60))).toBe(false)
        expect(limiter.isWhitelistedIP("::1%" + "a".repeat(61))).toBe(false)
    })

    it("lets a burst of concurrent requests from any loopback address through", async () => {
        for (const addr of ["127.0.0.1", "127.0.0.2", "::ffff:127.0.0.3", "::1"]) {
            const limiter = build()
            const handle = limiter.createMiddleware()
            const statuses = await Promise.all(
                Array.from({ length: 20 }, async () => {
                    const res = await handle(
                        new Request("http://localhost/", {
                            method: "POST",
                            body: "{}",
                        }),
                        async () => new Response("ok"),
                        server(addr),
                    )
                    return res.status
                }),
            )
            expect(statuses.filter(s => s === 429)).toHaveLength(0)
        }
    })

    it("still rate limits a burst from a remote peer", async () => {
        const limiter = build()
        const handle = limiter.createMiddleware()
        const statuses = await Promise.all(
            Array.from({ length: 20 }, async () => {
                const res = await handle(
                    new Request("http://localhost/", { method: "POST", body: "{}" }),
                    async () => new Response("ok"),
                    server("203.0.113.9"),
                )
                return res.status
            }),
        )
        expect(statuses.filter(s => s === 429).length).toBeGreaterThan(0)
    })

    it("still counts a remote peer against the limit", () => {
        const limiter = build()
        const req = new Request("http://localhost/")
        const ip = limiter.getClientIP(req, server("203.0.113.9"))
        expect(limiter.isTrustedInternalRequest(req, ip)).toBe(false)
    })
})

// A burst of 20 requests through the middleware, then 6 identity confirms in
// one block, all from `socketIp` with `headers`. Returns how many were refused.
async function refused(
    limiter: Limiter,
    socketIp: string,
    headers: Record<string, string>,
): Promise<{ burst: number; confirms: number }> {
    const handle = limiter.createMiddleware()
    const statuses = await Promise.all(
        Array.from({ length: 20 }, async () => {
            const res = await handle(
                new Request("http://localhost/", { method: "POST", body: "{}", headers }),
                async () => new Response("ok"),
                server(socketIp),
            )
            return res.status
        }),
    )
    const confirm = {
        method: "execute",
        params: [{ extra: "confirmTx", data: { content: { data: ["identity"] } } }],
    }
    let confirms = 0
    for (let i = 0; i < 6; i++) {
        const req = new Request("http://localhost/", { method: "POST", headers })
        const ip = limiter.getClientIP(req, server(socketIp))
        const res = handleIdentityTxRateLimit(req, ip, confirm as never, limiter)
        if (res?.status === 429) confirms++
    }
    return { burst: statuses.filter(s => s === 429).length, confirms }
}

describe("loopback in proxy headers (strict mode)", () => {
    // Only the socket peer can make a request local: a loopback address in a
    // proxy header is skipped like a trusted hop, whatever proxy sent it.
    // `TRUSTED_PROXIES` as .env.example gives it for nginx on localhost; the
    // proxy sets X-Real-IP to the client's address.
    const nginx = () =>
        build({ xffMode: "strict", trustedProxies: ["127.0.0.1/32", "::1/128"] })
    const realIp = { "x-real-ip": "203.0.113.9" }

    it.each([
        ["127.0.0.2", "203.0.113.9"],
        ["2130706434", "203.0.113.9"],
        ["127.0.0.1", "203.0.113.9"],
        ["::1", "203.0.113.9"],
        ["::ffff:7f00:1", "203.0.113.9"],
        ["127.0.0.2, 203.0.113.9", "203.0.113.9"],
        ["198.51.100.7", "198.51.100.7"],
    ])("counts X-Forwarded-For %s from a proxy on 127.0.0.1 as %s, not local", async (xff, client) => {
        const headers = { ...realIp, "x-forwarded-for": xff }
        const limiter = nginx()
        const req = new Request("http://localhost/", { headers })
        expect(limiter.getClientIP(req, server("127.0.0.1"))).toBe(client)
        expect(isLocal(limiter, "127.0.0.1", headers)).toBe(false)
        expect(await refused(limiter, "127.0.0.1", headers)).toEqual({ burst: 18, confirms: 2 })
    })

    it("keeps a host-local client behind the proxy local through the socket", async () => {
        for (const addr of ["127.0.0.1", "127.0.0.2"]) {
            const headers = { "x-forwarded-for": addr, "x-real-ip": addr }
            expect(isLocal(nginx(), "127.0.0.1", headers)).toBe(true)
            expect(await refused(nginx(), "127.0.0.1", headers)).toEqual({ burst: 0, confirms: 0 })
        }
    })

    it("keeps a socket peer on another 127/8 address local", async () => {
        expect(isLocal(nginx(), "127.0.0.2")).toBe(true)
        expect(await refused(nginx(), "127.0.0.2", {})).toEqual({ burst: 0, confirms: 0 })
    })

    it("falls back to the socket when a trusted proxy forwards only loopback", () => {
        const limiter = build({ xffMode: "strict", trustedProxies: ["172.16.0.0/12"] })
        for (const headers of [
            { "x-forwarded-for": "127.0.0.1" },
            { "x-forwarded-for": "127.0.0.2, ::1" },
            { "x-real-ip": "127.0.0.2" },
            { "cf-connecting-ip": "::1" },
            { "x-forwarded-for": "127.0.0.1", "x-real-ip": "::ffff:7f00:1", "cf-connecting-ip": "127.0.0.3" },
        ]) {
            const req = new Request("http://localhost/", { headers })
            expect(limiter.getClientIP(req, server("172.18.0.1"))).toBe("172.18.0.1")
            expect(isLocal(limiter, "172.18.0.1", headers)).toBe(false)
        }
    })

    it("skips a loopback X-Real-IP for the next header", () => {
        const limiter = build({ xffMode: "strict", trustedProxies: ["172.16.0.0/12"] })
        const req = new Request("http://localhost/", {
            headers: { "x-real-ip": "::1", "cf-connecting-ip": "198.51.100.7" },
        })
        expect(limiter.getClientIP(req, server("172.18.0.1"))).toBe("198.51.100.7")
    })

    it.each([
        [["6.6.6.6", ...Array(16).fill("172.18.0.1")], {}, "172.18.0.1"],
        [["6.6.6.6", ...Array(16).fill("::1")], realIp, "203.0.113.9"],
        [["6.6.6.6", ...Array(20).fill("127.0.0.2")], realIp, "203.0.113.9"],
        [[...Array(20).fill("172.18.0.1"), "198.51.100.7"], {}, "198.51.100.7"],
        [["6.6.6.6", ...Array(15).fill("172.18.0.1")], {}, "6.6.6.6"],
    ])("the X-Forwarded-For walk examines at most the last 16 entries (%#)", (chain, extra, client) => {
        const limiter = build({ xffMode: "strict", trustedProxies: ["172.16.0.0/12"] })
        const resolve = (entries: string[]) =>
            limiter.getClientIP(
                new Request("http://localhost/", {
                    headers: { ...extra, "x-forwarded-for": entries.join(", ") },
                }),
                server("172.18.0.1"),
            )
        expect(resolve(chain)).toBe(resolve(chain.slice(-16)))
        expect(resolve(chain)).toBe(client)
    })

    it("makes a same-host forwarder's clients local unless it sets a client header", () => {
        // What the docs say: listing the forwarder in TRUSTED_PROXIES is not
        // enough on its own; it must also set X-Forwarded-For or X-Real-IP.
        const limiter = build({ xffMode: "strict", trustedProxies: ["127.0.0.6/32"] })
        expect(isLocal(limiter, "127.0.0.6")).toBe(true)
        expect(isLocal(limiter, "127.0.0.6", { "x-forwarded-for": "6.6.6.6" })).toBe(false)
        expect(isLocal(limiter, "127.0.0.6", { "x-real-ip": "6.6.6.6" })).toBe(false)
    })
})

describe("loopback whitelist docs", () => {
    const repo = path.resolve(import.meta.dir, "../../..")
    const docs = [".env.example", "INSTALL.md", "docs/runbooks/proxy-setup.md"]
    const read = (file: string) =>
        fs
            .readFileSync(path.join(repo, file), "utf8")
            .replace(/^\s*#\s?/gm, "")
            .replace(/`/g, "")
            .replace(/\s+/g, " ")

    // The exemption covers the HTTP RPC only: OmniProtocol's per-IP limits
    // have no loopback exemption, so the docs must not read as covering
    // every per-address limit.
    it.each(docs)(
        "%s scopes the loopback exemption to the HTTP RPC",
        file => {
            const text = read(file)
            expect(text).toContain(
                "skips the HTTP RPC's per-address limits (HTTP rate limiter, identity confirm cap, web2 per-caller caps)",
            )
            expect(text).toContain("OmniProtocol's per-IP limits still apply")
            expect(text).not.toContain("skips the per-address request limits")
        },
    )

    // Listing a same-host forwarder in TRUSTED_PROXIES only helps when it
    // also sets a client-address header; otherwise its clients are local.
    it.each(docs)("%s says a same-host forwarder must set a client-address header", file => {
        expect(read(file)).toContain(
            "must set X-Forwarded-For or X-Real-IP to the client's address; a forwarder that sets neither makes every client it relays local",
        )
    })
})
