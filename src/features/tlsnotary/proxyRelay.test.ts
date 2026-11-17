/**
 * The in-process TLSNotary relay: one websocket per session, admitted only
 * with the session's secret id in the path, relayed byte for byte to the
 * checked target, and ended (port freed) at its lifetime, an idle gap, the
 * byte cap of either direction or the close of either side.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, jest, mock } from "bun:test"
import type { TCPSocketListener } from "bun"

process.env.TLSNOTARY_PROXY_PORT_MIN = "56700"
process.env.TLSNOTARY_PROXY_PORT_MAX = "56763"
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
const sharedState: Record<string, unknown> = {}
mock.module("@/utilities/sharedState", () => ({ getSharedState: sharedState }))

const { openRelaySession, endAllRelaySessions, endRelaySession, liveSessions, sessionIdFromPath } = await import(
    "./proxyRelay"
)
type RelaySession = Awaited<ReturnType<typeof import("./proxyRelay").openRelaySession>>

/** A TCP target that echoes, or answers a request with `reply` bytes. */
let target: TCPSocketListener<unknown>
let replyBytes = 0
const targetSeen: number[] = []
let targetOpen = 0
beforeAll(() => {
    target = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: {
            open() {
                targetOpen += 1
            },
            close() {
                targetOpen -= 1
            },
            data(socket, data) {
                targetSeen.push(data.byteLength)
                if (replyBytes > 0) socket.write(new Uint8Array(replyBytes).fill(7))
                else socket.write(data)
            },
        },
    })
})
afterAll(() => target.stop(true))
afterEach(() => {
    endAllRelaySessions()
    replyBytes = 0
    targetSeen.length = 0
})

const LIMITS = { maxLifetimeMs: 10_000, idleMs: 10_000, maxSentBytes: 4096, maxRecvBytes: 8192 }

async function open(limits: Partial<typeof LIMITS> = {}) {
    const session = (await openRelaySession({
        tokenId: "a".repeat(64),
        owner: "0xowner",
        clientKey: "127.0.0.1",
        domain: "example.test",
        dialHost: "127.0.0.1",
        targetPort: target.port,
        limits: { ...LIMITS, ...limits },
    })) as Exclude<RelaySession, "exhausted" | null>
    expect(typeof session).toBe("object")
    return session
}

function connect(session: { port: number }, path: string): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${session.port}${path}`)
    ws.binaryType = "arraybuffer"
    return new Promise((resolve, reject) => {
        ws.onopen = () => resolve(ws)
        ws.onerror = () => reject(new Error("websocket refused"))
    })
}

function nextMessage(ws: WebSocket): Promise<Uint8Array> {
    return new Promise(resolve => {
        ws.onmessage = ev => resolve(new Uint8Array(ev.data as ArrayBuffer))
    })
}

function closed(ws: WebSocket): Promise<number> {
    return new Promise(resolve => {
        if (ws.readyState === WebSocket.CLOSED) resolve(-1)
        ws.onclose = ev => resolve(ev.code)
    })
}

async function upgradeStatus(port: number, path: string): Promise<number> {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        headers: {
            Connection: "Upgrade",
            Upgrade: "websocket",
            "Sec-WebSocket-Version": "13",
            "Sec-WebSocket-Key": Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64"),
        },
    })
    return res.status
}

async function waitFor(done: () => boolean, ms = 2000): Promise<void> {
    const deadline = Date.now() + ms
    while (!done()) {
        if (Date.now() > deadline) throw new Error("condition not reached in time")
        await Bun.sleep(10)
    }
}

async function portFree(port: number): Promise<boolean> {
    try {
        const probe = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } })
        probe.stop(true)
        return true
    } catch {
        return false
    }
}

describe("TLSNotary relay session", () => {
    it("takes the session id from the last path segment, prefix stripped or not", () => {
        expect(sessionIdFromPath("/abc")).toBe("abc")
        expect(sessionIdFromPath("/tlsn/55001/abc/")).toBe("abc")
        expect(sessionIdFromPath("/")).toBe("")
    })

    it("binds loopback by default and relays both directions", async () => {
        const session = await open()
        expect(session.sessionId).toMatch(/^[0-9a-f]{64}$/)
        const ws = await connect(session, `/${session.sessionId}`)
        const reply = nextMessage(ws)
        ws.send(new Uint8Array([1, 2, 3, 4]))
        expect([...(await reply)]).toEqual([1, 2, 3, 4])
        expect(session.bytesSent).toBe(4)
        expect(session.bytesRecv).toBe(4)
        ws.close()
        expect(await session.ended).toBe("client-closed")
        expect(await portFree(session.port)).toBe(true)
    })

    it("refuses a missing or wrong session id and keeps the session for its owner", async () => {
        const session = await open()
        expect(await upgradeStatus(session.port, "/")).toBe(403)
        expect(await upgradeStatus(session.port, `/${"0".repeat(64)}`)).toBe(403)
        expect(await upgradeStatus(session.port, `/${session.sessionId.slice(0, 63)}`)).toBe(403)
        expect(session.refusedHandshakes).toBe(3)
        expect(session.endReason).toBeUndefined()
        const ws = await connect(session, `/tlsn/${session.port}/${session.sessionId}`)
        expect(ws.readyState).toBe(WebSocket.OPEN)
    })

    it("serves one websocket per session; a second one is refused", async () => {
        const session = await open()
        await connect(session, `/${session.sessionId}`)
        expect(await upgradeStatus(session.port, `/${session.sessionId}`)).toBe(409)
    })

    it("ends at its lifetime and frees the port", async () => {
        const session = await open({ maxLifetimeMs: 150 })
        const ws = await connect(session, `/${session.sessionId}`)
        const code = closed(ws)
        expect(await session.ended).toBe("lifetime")
        expect(await code).toBe(1008)
        expect(liveSessions()).toEqual([])
        expect(await portFree(session.port)).toBe(true)
    })

    it("ends at its lifetime even when nobody connects", async () => {
        const session = await open({ maxLifetimeMs: 100 })
        expect(await session.ended).toBe("lifetime")
        expect(await portFree(session.port)).toBe(true)
    })

    it("ends a connected session that relays nothing", async () => {
        const session = await open({ idleMs: 100 })
        await connect(session, `/${session.sessionId}`)
        expect(await session.ended).toBe("idle")
    })

    it("ends when the client sends past the sent cap and does not relay the excess", async () => {
        const session = await open({ maxSentBytes: 1000 })
        const ws = await connect(session, `/${session.sessionId}`)
        const reply = nextMessage(ws)
        ws.send(new Uint8Array(600))
        await reply
        ws.send(new Uint8Array(600))
        expect(await session.ended).toBe("sent-cap")
        expect(session.bytesSent).toBe(600)
        expect(targetSeen.reduce((a, b) => a + b, 0)).toBe(600)
        expect(await portFree(session.port)).toBe(true)
    })

    it("ends when the target sends past the received cap", async () => {
        replyBytes = 9000
        const session = await open({ maxRecvBytes: 8192 })
        const ws = await connect(session, `/${session.sessionId}`)
        const code = closed(ws)
        ws.send(new Uint8Array([1]))
        expect(await session.ended).toBe("recv-cap")
        expect(session.bytesRecv).toBeLessThanOrEqual(8192)
        expect(await code).toBe(1009)
        expect(await portFree(session.port)).toBe(true)
    })

    it("closes its target connection when the node ends the session", async () => {
        const session = await open()
        const ws = await connect(session, `/${session.sessionId}`)
        const reply = nextMessage(ws)
        ws.send(new Uint8Array([9]))
        await reply
        expect(targetOpen).toBe(1)
        endRelaySession(session, "shutdown")
        expect(await closed(ws)).toBe(1001)
        await waitFor(() => targetOpen === 0)
    })

    it("leaves no session, port or target connection behind after many sessions", async () => {
        const ports = new Set<number>()
        for (let round = 0; round < 10; round++) {
            const sessions = await Promise.all(Array.from({ length: 10 }, () => open()))
            await Promise.all(
                sessions.map(async (session, i) => {
                    ports.add(session.port)
                    const ws = await connect(session, `/${session.sessionId}`)
                    const reply = nextMessage(ws)
                    ws.send(new Uint8Array([round, i]))
                    await reply
                    if (i % 2 === 0) ws.close()
                    else endRelaySession(session, "shutdown")
                    await session.ended
                }),
            )
        }
        expect(liveSessions()).toEqual([])
        await waitFor(() => targetOpen === 0)
        for (const port of ports) expect(await portFree(port)).toBe(true)
    })

    it("ends when the target cannot be reached", async () => {
        const dead = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
        const port = dead.port
        dead.stop(true)
        const session = (await openRelaySession({
            tokenId: "b".repeat(64),
            owner: "0xowner",
            clientKey: "127.0.0.1",
            domain: "example.test",
            dialHost: "127.0.0.1",
            targetPort: port,
            limits: LIMITS,
        })) as any
        await connect(session, `/${session.sessionId}`)
        expect(await session.ended).toBe("target-unreachable")
    })
})
