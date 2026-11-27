/**
 * A web2 "create" opens a session that lives for 15 idle minutes, so what
 * its requests leave on the node must stay bounded whatever they carry. A
 * session keeps only short strings from its create request, and of a start
 * only a URL of at most 4096 characters; one caller holds at most 16
 * sessions, its least recently used one making room for the next; the node
 * holds at most 1024 and answers a create beyond that with 429 until one
 * expires.
 */

import { afterEach, beforeEach, describe, expect, it, jest, mock, spyOn } from "bun:test"

for (const key of [
    "WEB2_ENABLED",
    "WEB2_SESSION_TTL_MS",
    "WEB2_MAX_SESSIONS_PER_CALLER",
    "WEB2_MAX_SESSIONS_TOTAL",
    "WEB2_MAX_INFLIGHT_PER_CALLER",
    "WEB2_MAX_FETCHES_PER_MINUTE_PER_CALLER",
    "WEB2_MAX_BYTES_PER_HOUR_PER_CALLER",
    "WEB2_MAX_INFLIGHT_TOTAL",
]) {
    delete process.env[key]
}

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

const { EnumWeb2Actions } = await import("@kynesyslabs/demosdk/types")
const { DAHR } = await import("@/features/web2/dahr/DAHR")
const { DAHRFactory } = await import("@/features/web2/dahr/DAHRFactory")
const { Proxy } = await import("@/features/web2/proxy/Proxy")
const { Web2FetchLimiter } = await import("@/features/web2/web2FetchLimiter")
const { handleWeb2ProxyRequest } = await import(
    "@/libs/network/routines/transactions/handleWeb2ProxyRequest"
)

const TTL_MS = 15 * 60 * 1000
const PAD = "B".repeat(1_000_000)
// The documented limit of a start's URL, counted once it is normalized.
const URL_LIMIT = 4096
const ORIGIN = "https://example.com/"
const ORIGIN_REPLY = {
    status: 200,
    statusText: "OK",
    headers: {},
    data: "ok",
    responseHash: "",
    responseHeadersHash: "",
}
// Well after the clock other web2 test files use, so their sessions have
// expired by the first create here.
let now = 1_800_000_000_000

function create(
    key: string,
    raw: Record<string, unknown> = {},
    exempt = false,
    rest: Record<string, unknown> = {},
) {
    return handleWeb2ProxyRequest(
        {
            web2Request: {
                ...rest,
                raw: {
                    action: EnumWeb2Actions.CREATE,
                    method: "GET",
                    url: "https://example.com/",
                    headers: {},
                    ...raw,
                },
            } as any,
        },
        { key, exempt },
    )
}

/** Opens a session for `key` one clock tick after the last one. */
async function open(key: string, exempt = false): Promise<string> {
    now += 1
    const res = await create(key, {}, exempt)
    expect(res.result).toBe(200)
    return (res.response as any).dahr.sessionId
}

const live = (sessionId: string) =>
    DAHRFactory.instance.getDAHR(sessionId) !== undefined

function start(key: string, sessionId: string, url: string) {
    return handleWeb2ProxyRequest(
        {
            sessionId,
            web2Request: {
                raw: {
                    action: EnumWeb2Actions.START_PROXY,
                    method: "GET",
                    url,
                    headers: {},
                },
            } as any,
        },
        { key, exempt: false },
    )
}

/** The relay's fetch, replaced so that an admitted start reaches no origin. */
function stubRelay() {
    return spyOn(Proxy.prototype, "sendHTTPRequest").mockResolvedValue(
        ORIGIN_REPLY as any,
    )
}

/** Takes every fetch slot `key` has, so the limiter refuses its next start. */
function holdFetchSlots(key: string): () => void {
    const leases: { release(): void }[] = []
    for (;;) {
        const { lease } = Web2FetchLimiter.instance.acquire({ key, exempt: false })
        if (!lease) break
        leases.push(lease)
    }
    return () => leases.forEach(lease => lease.release())
}

/**
 * Characters of all the text a session holds: every string and key reachable
 * from it through plain objects, arrays, the session and its relay.
 */
function heldChars(sessionId: string): number {
    const seen = new Set<object>()
    const count = (value: unknown): number => {
        if (typeof value === "string") return value.length
        if (typeof value !== "object" || value === null || seen.has(value)) return 0
        seen.add(value)
        const proto = Object.getPrototypeOf(value)
        const walked =
            proto === Object.prototype ||
            Array.isArray(value) ||
            value instanceof DAHR ||
            value instanceof Proxy
        if (!walked) return 0
        return Object.entries(value).reduce(
            (sum, [key, item]) => sum + key.length + count(item),
            0,
        )
    }
    return count(DAHRFactory.instance.getDAHR(sessionId))
}

beforeEach(() => {
    // Every session of the previous test has expired by the next create.
    now += TTL_MS + 1
    spyOn(Date, "now").mockImplementation(() => now)
    // A limiter per test, on this test's clock.
    Web2FetchLimiter.resetInstance()
})

afterEach(() => {
    jest.restoreAllMocks()
})

describe("web2 create", () => {
    it("keeps none of the caller's other or oversized fields", async () => {
        const res = await create(
            "ip:203.0.113.1",
            {
                pad: PAD,
                headers: { "x-pad": PAD },
                parameters: [{ name: "pad", value: PAD }],
            },
            false,
            { result: PAD, hash: PAD, signature: PAD },
        )
        expect(res.result).toBe(200)
        expect(JSON.stringify(res.response).length).toBeLessThan(10_000)

        const { sessionId } = (res.response as any).dahr
        const kept = DAHRFactory.instance.getDAHR(sessionId).web2Request
        expect(JSON.stringify(kept).length).toBeLessThan(10_000)
        expect(kept.raw).not.toHaveProperty("pad")
        expect(kept.raw.action).toBe(EnumWeb2Actions.CREATE)
        expect(kept.raw.url).toBe("https://example.com/")
        expect(kept.raw.method).toBe("GET")

        const longUrl = await create("ip:203.0.113.1", {
            url: "https://example.com/" + "a".repeat(10_000),
        })
        expect(longUrl.result).toBe(200)
        expect(JSON.stringify(longUrl.response).length).toBeLessThan(10_000)
    })

    it("lets one caller hold 16 sessions, its least recently used making room", async () => {
        const caller = "ip:203.0.113.2"
        const ids: string[] = []
        for (let i = 0; i < 16; i++) ids.push(await open(caller))
        now += 1
        expect(live(ids[0])).toBe(true) // used again: ids[1] is now the oldest

        const newest = await open(caller)

        expect(live(ids[1])).toBe(false)
        for (const id of [ids[0], ...ids.slice(2), newest]) {
            expect(live(id)).toBe(true)
        }
        // Another caller is not affected.
        await open("ip:203.0.113.3")
        expect(live(ids[2])).toBe(true)
    })

    it("holds one caller to 16 sessions when its creates arrive together", async () => {
        now += 1
        const replies = await Promise.all(
            Array.from({ length: 20 }, () => create("ip:203.0.113.4")),
        )
        for (const res of replies) expect(res.result).toBe(200)
        const ids = replies.map(res => (res.response as any).dahr.sessionId)
        expect(ids.filter(live)).toHaveLength(16)
    })

    it("does not hold a whitelisted caller to 16 sessions", async () => {
        const ids: string[] = []
        for (let i = 0; i < 20; i++) ids.push(await open("ip:127.0.0.1", true))
        for (const id of ids) expect(live(id)).toBe(true)
    })

    it("refuses a create with 429 once the node holds 1024 sessions, until one expires", async () => {
        for (let n = 0; n < 64; n++) {
            for (let i = 0; i < 16; i++) await open(`ip:198.51.100.${n}`)
        }

        const refused = await create("ip:192.0.2.1")
        expect(refused.result).toBe(429)
        expect(refused.response).toMatchObject({
            error: "WEB2_FETCH_LIMITED",
            reason: "node-sessions",
        })
        const retry = (refused.response as any).retryAfterSeconds
        expect(retry).toBeGreaterThanOrEqual(1)
        expect(retry).toBeLessThanOrEqual(TTL_MS / 1000)

        // A caller at its own cap still gets one: its oldest makes room.
        expect((await create("ip:198.51.100.0")).result).toBe(200)

        now += TTL_MS + 1
        expect((await create("ip:192.0.2.1")).result).toBe(200)
    })
})

describe("web2 start", () => {
    it("refuses a 1 MB URL and keeps nothing of it", async () => {
        const caller = "ip:203.0.113.10"
        const relay = stubRelay()
        const sessionId = await open(caller)
        const before = heldChars(sessionId)
        expect(before).toBeLessThan(10_000)

        const res = await start(caller, sessionId, ORIGIN + "?q=" + PAD)

        expect(res.result).toBe(400)
        expect(res.extra).toBe("Invalid URL: longer than 4096 characters")
        expect(relay).not.toHaveBeenCalled()
        expect(heldChars(sessionId)).toBe(before)
    })

    it("keeps nothing of a start the fetch limiter refuses", async () => {
        const caller = "ip:203.0.113.11"
        const relay = stubRelay()
        const sessionId = await open(caller)
        const before = heldChars(sessionId)

        const release = holdFetchSlots(caller)
        try {
            const long = await start(caller, sessionId, ORIGIN + "?q=" + PAD)
            expect(long.result).toBe(400)
            const other = await start(
                caller,
                sessionId,
                "https://example.org/" + "a".repeat(4000),
            )
            expect(other.result).toBe(429)
        } finally {
            release()
        }

        expect(relay).not.toHaveBeenCalled()
        expect(heldChars(sessionId)).toBe(before)
        const kept = DAHRFactory.instance.getDAHR(sessionId).web2Request
        expect(kept.raw.url).toBe(ORIGIN)
    })

    it("measures a URL once it is normalized", async () => {
        const caller = "ip:203.0.113.12"
        const relay = stubRelay()
        const sessionId = await open(caller)
        // One character as sent, nine once percent-encoded.
        const euro = String.fromCharCode(0x20ac)

        const grows = ORIGIN + euro.repeat(500)
        expect(grows.length).toBeLessThan(URL_LIMIT)
        expect((await start(caller, sessionId, grows)).result).toBe(400)
        expect(relay).not.toHaveBeenCalled()

        const fits = ORIGIN + euro.repeat(400)
        expect((await start(caller, sessionId, fits)).result).toBe(200)
        const sent = (relay.mock.calls[0][0] as any).web2Request.raw.url
        expect(sent).toHaveLength(ORIGIN.length + 9 * 400)

        // A fragment is dropped by normalization, so it does not count.
        const shrinks = ORIGIN + "#" + "a".repeat(URL_LIMIT)
        expect((await start(caller, sessionId, shrinks)).result).toBe(200)
    })

    it("runs a start whose URL is at the limit, and refuses one character more", async () => {
        const caller = "ip:203.0.113.13"
        const relay = stubRelay()
        const sessionId = await open(caller)
        const before = heldChars(sessionId)
        const atLimit = ORIGIN + "a".repeat(URL_LIMIT - ORIGIN.length)

        const res = await start(caller, sessionId, atLimit)

        expect(res.result).toBe(200)
        expect(res.response).toEqual(ORIGIN_REPLY)
        expect(relay).toHaveBeenCalledTimes(1)
        expect((relay.mock.calls[0][0] as any).web2Request.raw.url).toBe(atLimit)
        // The session's own copy is as the create left it.
        expect(heldChars(sessionId)).toBe(before)

        expect((await start(caller, sessionId, atLimit + "a")).result).toBe(400)
        // The session refuses it as well when it is started directly.
        const dahr = DAHRFactory.instance.getDAHR(sessionId)
        await expect(
            dahr.startProxy({
                method: "GET",
                headers: {},
                url: atLimit + "a",
            } as any),
        ).rejects.toThrow("Invalid URL: longer than 4096 characters")
        expect(relay).toHaveBeenCalledTimes(1)
    })
})
