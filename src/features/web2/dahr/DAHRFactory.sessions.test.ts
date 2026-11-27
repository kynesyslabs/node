/**
 * Creating a web2 (DAHR) session needs no signature or fee, and each session
 * can hold a relay for its whole idle lifetime, so open sessions are capped
 * per caller and per node, and a create counts toward the caller's fetch rate.
 */

import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test"

const quietLog = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() }
mock.module("src/utilities/logger", () => ({ __esModule: true, default: quietLog }))
mock.module("@/utilities/logger", () => ({ __esModule: true, default: quietLog }))

const { Config } = await import("src/config")
const { DAHRFactory } = await import("./DAHRFactory")
const { DAHRSessionLimitError, WEB2_SESSIONS_LIMITED } = await import("./sessionLimitError")
const { Web2FetchLimiter, WEB2_FETCH_LIMITED } = await import("src/features/web2/web2FetchLimiter")
const { handleWeb2ProxyRequest } = await import(
    "src/libs/network/routines/transactions/handleWeb2ProxyRequest"
)

const ENV = [
    "WEB2_MAX_SESSIONS_PER_CALLER",
    "WEB2_MAX_SESSIONS_TOTAL",
    "WEB2_MAX_FETCHES_PER_MINUTE_PER_CALLER",
    "WEB2_SESSION_TTL_MS",
] as const

const request: any = {
    raw: { action: "create", method: "GET", url: "https://example.com/", headers: {} },
    result: null,
    attestations: {},
    hash: "",
    signature: "",
}
const alice = { key: "ip:1.1.1.1" }
const bob = { key: "ip:2.2.2.2" }

function configure(env: Partial<Record<(typeof ENV)[number], string>>) {
    for (const [k, v] of Object.entries(env)) process.env[k] = v
    Config.resetInstance()
    DAHRFactory.resetInstance()
    Web2FetchLimiter.resetInstance()
}

beforeEach(() => configure({}))
afterEach(() => {
    for (const k of ENV) delete process.env[k]
    configure({})
})

describe("DAHRFactory session caps", () => {
    it("refuses a caller past its own cap, but not another caller", async () => {
        configure({ WEB2_MAX_SESSIONS_PER_CALLER: "2", WEB2_MAX_SESSIONS_TOTAL: "10" })
        const f = DAHRFactory.instance
        await f.createDAHR(request, alice)
        await f.createDAHR(request, alice)
        const refused = await f.createDAHR(request, alice).catch(e => e)
        expect(refused).toBeInstanceOf(DAHRSessionLimitError)
        expect(refused.reason).toBe("caller-sessions")
        await f.createDAHR(request, bob)
        expect(f.sessionCount(alice.key)).toBe(2)
        expect(f.sessionCount()).toBe(3)
    })

    it("refuses every caller past the node cap, exempt ones too", async () => {
        configure({ WEB2_MAX_SESSIONS_PER_CALLER: "5", WEB2_MAX_SESSIONS_TOTAL: "2" })
        const f = DAHRFactory.instance
        await f.createDAHR(request, alice)
        await f.createDAHR(request, { key: "ip:127.0.0.1", exempt: true })
        for (const caller of [bob, { key: "ip:127.0.0.1", exempt: true }, undefined]) {
            const refused = await f.createDAHR(request, caller).catch(e => e)
            expect(refused).toBeInstanceOf(DAHRSessionLimitError)
            expect(refused.reason).toBe("node-sessions")
        }
    })

    it("an exempt caller skips the per-caller cap", async () => {
        configure({ WEB2_MAX_SESSIONS_PER_CALLER: "1", WEB2_MAX_SESSIONS_TOTAL: "10" })
        const local = { key: "ip:127.0.0.1", exempt: true }
        await DAHRFactory.instance.createDAHR(request, local)
        await DAHRFactory.instance.createDAHR(request, local)
        expect(DAHRFactory.instance.sessionCount()).toBe(2)
    })

    it("an expired session frees its slot", async () => {
        configure({ WEB2_MAX_SESSIONS_PER_CALLER: "1", WEB2_SESSION_TTL_MS: "20" })
        await DAHRFactory.instance.createDAHR(request, alice)
        await new Promise(r => setTimeout(r, 40))
        await DAHRFactory.instance.createDAHR(request, alice)
        expect(DAHRFactory.instance.sessionCount(alice.key)).toBe(1)
    })
})

describe("web2ProxyRequest create", () => {
    it("answers a session cap with 429 WEB2_SESSIONS_LIMITED", async () => {
        configure({ WEB2_MAX_SESSIONS_PER_CALLER: "1" })
        expect((await handleWeb2ProxyRequest({ web2Request: request } as any, alice)).result).toBe(200)
        const reply = await handleWeb2ProxyRequest({ web2Request: request } as any, alice)
        expect(reply.result).toBe(429)
        expect(reply.response).toMatchObject({ error: WEB2_SESSIONS_LIMITED, reason: "caller-sessions" })
    })

    it("counts a create toward the caller's fetch rate", async () => {
        configure({ WEB2_MAX_FETCHES_PER_MINUTE_PER_CALLER: "2" })
        for (let i = 0; i < 2; i++) {
            expect((await handleWeb2ProxyRequest({ web2Request: request } as any, alice)).result).toBe(200)
        }
        const reply = await handleWeb2ProxyRequest({ web2Request: request } as any, alice)
        expect(reply.result).toBe(429)
        expect(reply.response).toMatchObject({ error: WEB2_FETCH_LIMITED, reason: "caller-rate" })
        expect(Web2FetchLimiter.instance.stats().inflightTotal).toBe(0)
        expect(DAHRFactory.instance.sessionCount()).toBe(2)
    })
})
