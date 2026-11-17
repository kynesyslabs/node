/**
 * requestTLSNproxy hands a relay session only to the signer of a confirmed,
 * unexpired tlsn_request for the same host, one live session per token and a
 * bounded number per token, owner and address. The token is the request's
 * hash, read from the chain, so a caller-supplied `owner` proves nothing.
 */
import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test"

process.env.TLSNOTARY_PROXY_PORT_MIN = "56800"
process.env.TLSNOTARY_PROXY_PORT_MAX = "56863"
process.env.TLSNOTARY_ENABLED = "true"
process.env.EXPOSED_URL = "http://localhost:53550"
process.env.TLSNOTARY_ALLOW_PRIVATE_TARGETS = "true"
delete process.env.WSTCP_BIND_HOST

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

const NOW_SEC = Math.floor(Date.now() / 1000)
const chain = {
    requests: new Map<string, Record<string, unknown>>(),
    blockTime: new Map<number, number>(),
}
mock.module("@/libs/tlsnotary/tlsnChainReads", () => ({
    findTlsnRequest: async (hash: string) => chain.requests.get(hash) ?? null,
    blockTimestampSec: async (n: number) => chain.blockTime.get(n) ?? null,
    findTlsnLinkHits: async () => ({ userIdLinked: false, attestationUsed: false }),
    tipBlockTimestampSec: async () => NOW_SEC,
}))

const { Config } = await import("src/config")
const { requestTlsnProxy } = await import("@/features/tlsnotary/proxyRequest")
const { handlerRegistry } = await import("./index")
const { resetProxyAccessState } = await import("@/features/tlsnotary/proxyAccess")
const { liveSessions, endAllRelaySessions } = await import("@/features/tlsnotary/proxyRelay")
const { PROXY_LIMITS } = await import("@/features/tlsnotary/constants")

const ALICE = "a1".repeat(32)
const BOB = "b0".repeat(32)
const TARGET = "https://api.example.test/v1/me"

let seq = 0
/** A tlsn_request on chain; returns its hash. */
function onChain(over: Record<string, unknown> = {}, ageSec = 60): string {
    seq += 1
    const hash = seq.toString(16).padStart(64, "0")
    const blockNumber = 1000 + seq
    chain.blockTime.set(blockNumber, NOW_SEC - ageSec)
    chain.requests.set(hash, {
        hash,
        status: "confirmed",
        blockNumber,
        sender: `0x${ALICE}`,
        type: "native",
        nativeOperation: "tlsn_request",
        targetUrl: TARGET,
        ...over,
    })
    return hash
}

let ipSeq = 0
/** A fresh caller address, so tests do not share the per-address budget. */
function freshIp(): string {
    ipSeq += 1
    return `198.51.100.${ipSeq}`
}

function call(tokenId: unknown, sender: string, ip = freshIp(), extra: Record<string, unknown> = {}) {
    return requestTlsnProxy({ tokenId, targetUrl: TARGET, ...extra }, sender, ip) as Promise<any>
}

beforeEach(() => {
    Config.resetInstance()
    resetProxyAccessState()
})
afterEach(() => {
    endAllRelaySessions()
    chain.requests.clear()
    chain.blockTime.clear()
})

describe("requestTLSNproxy authorisation", () => {
    it("opens a session for the signer of a confirmed tlsn_request", async () => {
        const hash = onChain()
        const res = await call(hash, ALICE)
        expect(res.error).toBeUndefined()
        expect(res.tokenId).toBe(hash)
        expect(res.retriesLeft).toBe(PROXY_LIMITS.MAX_SESSIONS_PER_TOKEN - 1)
        expect(res.websocketProxyUrl).toMatch(/^ws:\/\/localhost:568\d\d\/[0-9a-f]{64}$/)
        expect(res.expiresIn).toBeLessThanOrEqual(PROXY_LIMITS.SESSION_MAX_LIFETIME_MS)
        expect(res.maxSentBytes).toBeGreaterThan(Config.getInstance().tlsnotary.maxSentData)
        expect(res.maxRecvBytes).toBeGreaterThan(Config.getInstance().tlsnotary.maxRecvData)
        const [session] = liveSessions()
        expect(res.websocketProxyUrl.endsWith(session.sessionId)).toBe(true)
        expect(session.owner).toBe(`0x${ALICE}`)
    })

    it("accepts the 0x and upper-case spellings of the hash and the signer", async () => {
        const hash = onChain()
        const res = await call(`0x${hash.toUpperCase()}`, `0x${ALICE.toUpperCase()}`)
        expect(res.error).toBeUndefined()
    })

    it("answers through the nodeCall handler with the refusal status", async () => {
        const response: any = { result: 0, response: null, require_reply: false, extra: null }
        await handlerRegistry.requestTLSNproxy({ tokenId: onChain(), targetUrl: TARGET }, response, "", "203.0.113.9")
        expect(response.result).toBe(401)
        expect(response.response.error).toBe("AUTH_REQUIRED")
    })

    it("refuses an unsigned call even with the right owner field", async () => {
        const res = await call(onChain(), "", freshIp(), { owner: ALICE })
        expect(res.status).toBe(401)
        expect(res.error).toBe("AUTH_REQUIRED")
        expect(liveSessions()).toEqual([])
    })

    it("refuses an owner field that is not the signer", async () => {
        const res = await call(onChain(), BOB, freshIp(), { owner: ALICE })
        expect(res.status).toBe(403)
        expect(res.error).toBe("TOKEN_OWNER_MISMATCH")
    })

    it("refuses without a token, with a malformed one and with an unknown one", async () => {
        expect((await call(undefined, ALICE)).error).toBe("INVALID_REQUEST")
        expect((await call("tlsn_0b5c0c39-0000-4000-8000-000000000000", ALICE)).error).toBe("INVALID_TOKEN")
        const unknown = await call("f".repeat(64), ALICE)
        expect(unknown.status).toBe(404)
        expect(unknown.error).toBe("TOKEN_NOT_FOUND")
    })

    it("refuses a tlsn_request another account sent", async () => {
        const res = await call(onChain({ sender: `0x${BOB}` }), ALICE)
        expect(res.status).toBe(403)
        expect(res.error).toBe("TOKEN_OWNER_MISMATCH")
        expect(liveSessions()).toEqual([])
    })

    it("refuses a failed transaction and one that is not a tlsn_request", async () => {
        expect((await call(onChain({ status: "failed" }), ALICE)).error).toBe("TOKEN_NOT_CONFIRMED")
        expect((await call(onChain({ nativeOperation: "send" }), ALICE)).error).toBe("TOKEN_NOT_CONFIRMED")
    })

    it("refuses a target on another host than the request's", async () => {
        const res = await requestTlsnProxy(
            { tokenId: onChain(), targetUrl: "https://other.example.test/" },
            ALICE,
            freshIp(),
        )
        expect(res.error).toBe("TOKEN_DOMAIN_MISMATCH")
    })

    it("refuses an expired tlsn_request", async () => {
        const res = await call(onChain({}, 31 * 60), ALICE)
        expect(res.status).toBe(403)
        expect(res.error).toBe("TOKEN_EXPIRED")
    })

    it("keeps one live session per token and refuses the token once its sessions are used", async () => {
        const hash = onChain()
        const first = await call(hash, ALICE)
        const firstSession = liveSessions()[0]
        const second = await call(hash, ALICE)
        expect(second.error).toBeUndefined()
        expect(await firstSession.ended).toBe("superseded")
        expect(liveSessions().map(s => s.proxyId)).toEqual([second.proxyId])
        expect(second.proxyId).not.toBe(first.proxyId)
        const third = await call(hash, ALICE)
        expect(third.retriesLeft).toBe(0)
        const reused = await call(hash, ALICE)
        expect(reused.status).toBe(403)
        expect(reused.error).toBe("TOKEN_EXHAUSTED")
        expect(liveSessions().length).toBe(1)
    })

    it("refuses a second concurrent open of the same token", async () => {
        const hash = onChain()
        const results = await Promise.all([call(hash, ALICE), call(hash, ALICE)])
        expect(results.map(r => r.error ?? "ok").sort()).toEqual(["TOKEN_BUSY", "ok"])
        expect(liveSessions().length).toBe(1)
    })

    it("does not count a refused open against the token", async () => {
        const hash = onChain()
        process.env.TLSNOTARY_ALLOWED_PORTS = "8443"
        Config.resetInstance()
        try {
            expect((await call(hash, ALICE)).error).toBe("TARGET_NOT_ALLOWED")
        } finally {
            delete process.env.TLSNOTARY_ALLOWED_PORTS
            Config.resetInstance()
        }
        expect((await call(hash, ALICE)).retriesLeft).toBe(PROXY_LIMITS.MAX_SESSIONS_PER_TOKEN - 1)
    })
})

describe("requestTLSNproxy limits", () => {
    it("caps live sessions per owner", async () => {
        for (let i = 0; i < PROXY_LIMITS.MAX_LIVE_SESSIONS_PER_OWNER; i++) {
            expect((await call(onChain(), ALICE)).error).toBeUndefined()
        }
        const res = await call(onChain(), ALICE)
        expect(res.status).toBe(429)
        expect(res.error).toBe("OWNER_SESSION_LIMIT")
        expect((await call(onChain({ sender: `0x${BOB}` }), BOB)).error).toBeUndefined()
    })

    it("caps live sessions per address, a whole IPv6 /64 counting as one", async () => {
        const owners = Array.from({ length: PROXY_LIMITS.MAX_LIVE_SESSIONS_PER_IP + 1 }, (_, i) =>
            (i + 1).toString(16).padStart(64, "c"),
        )
        for (let i = 0; i < PROXY_LIMITS.MAX_LIVE_SESSIONS_PER_IP; i++) {
            const owner = owners[i]
            const res = await call(onChain({ sender: owner }), owner, `2001:db8:1:2::${i + 1}`)
            expect(res.error).toBeUndefined()
        }
        const last = owners[PROXY_LIMITS.MAX_LIVE_SESSIONS_PER_IP]
        const res = await call(onChain({ sender: last }), last, "2001:db8:1:2::ff")
        expect(res.status).toBe(429)
        expect(res.error).toBe("IP_SESSION_LIMIT")
        expect((await call(onChain({ sender: last }), last, "203.0.113.200")).error).toBeUndefined()
    })

    it("rate-limits requests per address before reading the chain", async () => {
        const ip = "203.0.113.50"
        for (let i = 0; i < PROXY_LIMITS.REQUESTS_PER_WINDOW_PER_IP; i++) {
            expect((await call("f".repeat(64), `${i}`.padStart(64, "d"), ip)).error).toBe("TOKEN_NOT_FOUND")
        }
        const res = await call(onChain(), ALICE, ip)
        expect(res.status).toBe(429)
        expect(res.error).toBe("RATE_LIMITED")
    })

    it("rate-limits requests per owner across addresses", async () => {
        for (let i = 0; i < PROXY_LIMITS.REQUESTS_PER_WINDOW_PER_OWNER; i++) {
            expect((await call("f".repeat(64), BOB)).error).toBe("TOKEN_NOT_FOUND")
        }
        const res = await call(onChain({ sender: `0x${BOB}` }), BOB)
        expect(res.status).toBe(429)
        expect(res.error).toBe("RATE_LIMITED")
    })

    it("serves nothing when TLSNotary is off on this node", async () => {
        process.env.TLSNOTARY_ENABLED = "false"
        Config.resetInstance()
        try {
            const res = await call(onChain(), ALICE)
            expect(res.status).toBe(503)
            expect(res.error).toBe("PROXY_DISABLED")
        } finally {
            process.env.TLSNOTARY_ENABLED = "true"
            Config.resetInstance()
        }
    })
})
