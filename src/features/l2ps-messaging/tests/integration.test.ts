/**
 * L2PS Messaging Integration Tests
 *
 * Tests the actual WebSocket server with real connections.
 * Uses a lightweight test server that bypasses L2PS/DB dependencies.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import type { Server, ServerWebSocket } from "bun"
import type { ProtocolFrame } from "../types"

// ─── Test Server ─────────────────────────────────────────────────
// Stripped-down version of L2PSMessagingServer for integration tests
// without DB/L2PS dependencies

interface WSData { publicKey: string | null; l2psUid: string | null }

let server: Server
let port: number
const peers = new Map<string, { publicKey: string; l2psUid: string; ws: ServerWebSocket<WSData> }>()

function send(ws: ServerWebSocket<WSData>, frame: ProtocolFrame) {
    ws.send(JSON.stringify(frame))
}

/** Parse + structural-validate; returns null after sending an error. */
function parseIncomingFrame(
    ws: ServerWebSocket<WSData>,
    msg: string,
): ProtocolFrame | null {
    if (msg.length > MAX_MESSAGE_SIZE) {
        sendError(ws, "INVALID_MESSAGE", "Message too large")
        return null
    }
    let frame: ProtocolFrame
    try {
        frame = JSON.parse(msg)
    } catch {
        sendError(ws, "INVALID_MESSAGE", "Invalid JSON")
        return null
    }
    if (
        !frame.type ||
        typeof frame.type !== "string" ||
        !frame.payload ||
        typeof frame.payload !== "object"
    ) {
        sendError(ws, "INVALID_MESSAGE", "Missing or invalid type/payload")
        return null
    }
    return frame
}

function dispatchFrame(
    ws: ServerWebSocket<WSData>,
    frame: ProtocolFrame,
): void {
    switch (frame.type) {
        case "register":
            handleRegister(ws, frame.payload as any)
            return
        case "send":
            handleSend(ws, frame.payload as any)
            return
        case "discover":
            handleDiscover(ws)
            return
        case "request_public_key":
            handleRequestPublicKey(ws, frame.payload as any)
            return
        default:
            sendError(ws, "INVALID_MESSAGE", `Unknown type: ${frame.type}`)
    }
}

function handleRegister(
    ws: ServerWebSocket<WSData>,
    payload: { publicKey?: string; l2psUid?: string },
): void {
    const { publicKey, l2psUid } = payload
    if (!publicKey || !l2psUid) {
        sendError(ws, "INVALID_MESSAGE", "Missing fields")
        return
    }
    ws.data.publicKey = publicKey
    ws.data.l2psUid = l2psUid
    peers.set(publicKey, { publicKey, l2psUid, ws })
    const onlinePeers = Array.from(peers.values())
        .filter(p => p.l2psUid === l2psUid && p.publicKey !== publicKey)
        .map(p => p.publicKey)
    send(ws, {
        type: "registered",
        payload: { success: true, publicKey, l2psUid, onlinePeers },
        timestamp: Date.now(),
    })
    for (const pk of onlinePeers) {
        const p = peers.get(pk)
        if (p) {
            send(p.ws, {
                type: "peer_joined",
                payload: { publicKey },
                timestamp: Date.now(),
            })
        }
    }
}

function handleSend(
    ws: ServerWebSocket<WSData>,
    payload: { to?: string; encrypted?: any; messageHash?: string },
): void {
    if (!ws.data.publicKey) {
        sendError(ws, "REGISTRATION_REQUIRED", "Register first")
        return
    }
    const { to, encrypted, messageHash } = payload
    if (!to || !encrypted || !messageHash) {
        sendError(ws, "INVALID_MESSAGE", "Missing fields")
        return
    }
    if (!encrypted.ciphertext || !encrypted.nonce) {
        sendError(ws, "INVALID_MESSAGE", "Bad encrypted payload")
        return
    }
    if (to === ws.data.publicKey) {
        sendError(ws, "INVALID_MESSAGE", "Cannot send to yourself")
        return
    }
    const recipient = peers.get(to)
    const online = !!recipient && recipient.l2psUid === ws.data.l2psUid
    if (online && recipient) {
        send(recipient.ws, {
            type: "message",
            payload: {
                from: ws.data.publicKey,
                encrypted,
                messageHash,
                offline: false,
            },
            timestamp: Date.now(),
        })
        send(ws, {
            type: "message_sent",
            payload: { messageHash, l2psStatus: "submitted" },
            timestamp: Date.now(),
        })
    } else {
        send(ws, {
            type: "message_queued",
            payload: { messageHash, status: "queued" },
            timestamp: Date.now(),
        })
    }
}

function handleDiscover(ws: ServerWebSocket<WSData>): void {
    const l2psUid = ws.data.l2psUid
    const list = Array.from(peers.values())
        .filter(p => !l2psUid || p.l2psUid === l2psUid)
        .map(p => p.publicKey)
    send(ws, {
        type: "discover_response",
        payload: { peers: list },
        timestamp: Date.now(),
    })
}

function handleRequestPublicKey(
    ws: ServerWebSocket<WSData>,
    payload: { targetId?: string },
): void {
    const target = peers.get(payload.targetId ?? "")
    send(ws, {
        type: "public_key_response",
        payload: { targetId: payload.targetId, publicKey: target?.publicKey ?? null },
        timestamp: Date.now(),
    })
}

function sendError(ws: ServerWebSocket<WSData>, code: string, message: string) {
    send(ws, { type: "error", payload: { code, message }, timestamp: Date.now() })
}

const MAX_MESSAGE_SIZE = 256 * 1024

beforeAll(() => {
    port = 19876 + Math.floor(Math.random() * 1000)
    server = Bun.serve({
        port,
        fetch: (req, server) => {
            if (server.upgrade(req, { data: { publicKey: null, l2psUid: null } })) return undefined
            return new Response("Upgrade required", { status: 426 })
        },
        websocket: {
            // Bun.serve dropped the WSData generic on the outer Server
            // type, so the dispatcher hands us ws as
            // ServerWebSocket<unknown>. Re-narrow at the boundary; the
            // upgrade() handler above guarantees the shape. Per-case
            // handlers extracted as top-level fns to keep cognitive
            // complexity bounded.
            message(wsAny, raw) {
                const ws = wsAny as ServerWebSocket<WSData>
                const frame = parseIncomingFrame(ws, raw as string)
                if (!frame) return
                dispatchFrame(ws, frame)
            },
            open() {},
            close(wsAny) {
                const ws = wsAny as ServerWebSocket<WSData>
                const pk = ws.data.publicKey
                if (!pk) return
                const peer = peers.get(pk)
                if (!peer) return
                const uid = peer.l2psUid
                peers.delete(pk)
                for (const [, p] of peers) {
                    if (p.l2psUid === uid) send(p.ws, { type: "peer_left", payload: { publicKey: pk }, timestamp: Date.now() })
                }
            },
        },
    })
})

afterAll(() => {
    server.stop()
})

beforeEach(() => {
    peers.clear()
})

// ─── Helpers ─────────────────────────────────────────────────────

function connect(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${port}`)
        ws.addEventListener("open", () => resolve(ws))
        ws.addEventListener("error", reject)
    })
}

function sendFrame(ws: WebSocket, type: string, payload: Record<string, unknown>): void {
    ws.send(JSON.stringify({ type, payload, timestamp: Date.now() }))
}

function waitForMessage(ws: WebSocket, expectedType?: string, timeout = 2000): Promise<ProtocolFrame> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${expectedType ?? "any"}`)), timeout)
        const handler = (event: MessageEvent) => {
            const frame = JSON.parse(event.data) as ProtocolFrame
            if (!expectedType || frame.type === expectedType) {
                clearTimeout(timer)
                ws.removeEventListener("message", handler)
                resolve(frame)
            }
        }
        ws.addEventListener("message", handler)
    })
}

function collectMessages(ws: WebSocket, count: number, timeout = 2000): Promise<ProtocolFrame[]> {
    return new Promise((resolve, reject) => {
        const msgs: ProtocolFrame[] = []
        const timer = setTimeout(() => resolve(msgs), timeout)
        const handler = (event: MessageEvent) => {
            msgs.push(JSON.parse(event.data))
            if (msgs.length >= count) {
                clearTimeout(timer)
                ws.removeEventListener("message", handler)
                resolve(msgs)
            }
        }
        ws.addEventListener("message", handler)
    })
}

async function registerPeer(publicKey: string, l2psUid = "test_net") {
    const ws = await connect()
    sendFrame(ws, "register", { publicKey, l2psUid, proof: "test" })
    const resp = await waitForMessage(ws, "registered")
    return { ws, resp }
}

function close(ws: WebSocket) {
    return new Promise<void>(resolve => {
        ws.addEventListener("close", () => resolve())
        ws.close()
    })
}

// ─── Tests ───────────────────────────────────────────────────────

describe("Integration: Connection", () => {
    it("should establish WebSocket connection", async () => {
        const ws = await connect()
        expect(ws.readyState).toBe(WebSocket.OPEN)
        ws.close()
    })

    it("should return 426 for non-WebSocket HTTP requests", async () => {
        const resp = await fetch(`http://localhost:${port}`)
        expect(resp.status).toBe(426)
    })
})

describe("Integration: Registration", () => {
    it("should register a peer and get confirmation", async () => {
        const { ws, resp } = await registerPeer("aabb" + "cc".repeat(31))
        expect(resp.type).toBe("registered")
        expect((resp.payload as any).success).toBe(true)
        ws.close()
    })

    it("should return online peers on registration", async () => {
        const { ws: ws1 } = await registerPeer("aa".repeat(32))
        const { ws: ws2, resp } = await registerPeer("bb".repeat(32))
        expect((resp.payload as any).onlinePeers).toContain("aa".repeat(32))
        ws1.close()
        ws2.close()
    })

    it("should notify existing peers when new peer joins", async () => {
        const { ws: ws1 } = await registerPeer("11".repeat(32))
        const joinPromise = waitForMessage(ws1, "peer_joined")
        const { ws: ws2 } = await registerPeer("22".repeat(32))
        const notification = await joinPromise
        expect((notification.payload as any).publicKey).toBe("22".repeat(32))
        ws1.close()
        ws2.close()
    })

    it("should reject registration with missing fields", async () => {
        const ws = await connect()
        sendFrame(ws, "register", { publicKey: "abc" })
        const resp = await waitForMessage(ws, "error")
        expect((resp.payload as any).code).toBe("INVALID_MESSAGE")
        ws.close()
    })
})

describe("Integration: Messaging", () => {
    it("should deliver message to online recipient", async () => {
        const { ws: sender } = await registerPeer("aa".repeat(32))
        const { ws: recipient } = await registerPeer("bb".repeat(32))

        const msgPromise = waitForMessage(recipient, "message")
        sendFrame(sender, "send", {
            to: "bb".repeat(32),
            encrypted: { ciphertext: "hello_enc", nonce: "nonce123" },
            messageHash: "hash_abc",
        })

        const msg = await msgPromise
        expect((msg.payload as any).from).toBe("aa".repeat(32))
        expect((msg.payload as any).encrypted.ciphertext).toBe("hello_enc")
        expect((msg.payload as any).offline).toBe(false)

        const ack = await waitForMessage(sender, "message_sent")
        expect((ack.payload as any).messageHash).toBe("hash_abc")

        sender.close()
        recipient.close()
    })

    it("should queue message when recipient offline", async () => {
        const { ws: sender } = await registerPeer("aa".repeat(32))

        sendFrame(sender, "send", {
            to: "cc".repeat(32), // not registered
            encrypted: { ciphertext: "data", nonce: "nonce" },
            messageHash: "hash_offline",
        })

        const resp = await waitForMessage(sender, "message_queued")
        expect((resp.payload as any).status).toBe("queued")
        sender.close()
    })

    it("should require registration before sending", async () => {
        const ws = await connect()
        sendFrame(ws, "send", {
            to: "bb".repeat(32),
            encrypted: { ciphertext: "x", nonce: "y" },
            messageHash: "h",
        })
        const resp = await waitForMessage(ws, "error")
        expect((resp.payload as any).code).toBe("REGISTRATION_REQUIRED")
        ws.close()
    })

    it("should reject sending to yourself", async () => {
        const key = "dd".repeat(32)
        const { ws } = await registerPeer(key)
        sendFrame(ws, "send", {
            to: key,
            encrypted: { ciphertext: "x", nonce: "y" },
            messageHash: "h",
        })
        const resp = await waitForMessage(ws, "error")
        expect((resp.payload as any).code).toBe("INVALID_MESSAGE")
        expect((resp.payload as any).message).toContain("yourself")
        ws.close()
    })

    it("should reject message without ciphertext/nonce", async () => {
        const { ws } = await registerPeer("ee".repeat(32))
        sendFrame(ws, "send", {
            to: "ff".repeat(32),
            encrypted: { bad: "data" },
            messageHash: "h",
        })
        const resp = await waitForMessage(ws, "error")
        expect((resp.payload as any).code).toBe("INVALID_MESSAGE")
        ws.close()
    })

    it("should not route messages across L2PS networks", async () => {
        const { ws: sender } = await registerPeer("aa".repeat(32), "net1")
        const { ws: recipient } = await registerPeer("bb".repeat(32), "net2")

        sendFrame(sender, "send", {
            to: "bb".repeat(32),
            encrypted: { ciphertext: "x", nonce: "y" },
            messageHash: "cross_net",
        })

        // Recipient is in different network, so message should be queued
        const resp = await waitForMessage(sender, "message_queued")
        expect((resp.payload as any).status).toBe("queued")

        sender.close()
        recipient.close()
    })
})

describe("Integration: Discovery", () => {
    it("should return list of online peers", async () => {
        const { ws: ws1 } = await registerPeer("aa".repeat(32))
        const { ws: ws2 } = await registerPeer("bb".repeat(32))

        sendFrame(ws1, "discover", {})
        const resp = await waitForMessage(ws1, "discover_response")
        const peerList = (resp.payload as any).peers as string[]
        expect(peerList).toContain("aa".repeat(32))
        expect(peerList).toContain("bb".repeat(32))

        ws1.close()
        ws2.close()
    })

    it("should only return peers in same L2PS network", async () => {
        const { ws: ws1 } = await registerPeer("aa".repeat(32), "net1")
        await registerPeer("bb".repeat(32), "net2")

        sendFrame(ws1, "discover", {})
        const resp = await waitForMessage(ws1, "discover_response")
        const peerList = (resp.payload as any).peers as string[]
        expect(peerList).toContain("aa".repeat(32))
        expect(peerList).not.toContain("bb".repeat(32))

        ws1.close()
    })
})

describe("Integration: Public Key Request", () => {
    it("should return public key for online peer", async () => {
        const { ws: ws1 } = await registerPeer("aa".repeat(32))
        const { ws: ws2 } = await registerPeer("bb".repeat(32))

        sendFrame(ws1, "request_public_key", { targetId: "bb".repeat(32) })
        const resp = await waitForMessage(ws1, "public_key_response")
        expect((resp.payload as any).publicKey).toBe("bb".repeat(32))

        ws1.close()
        ws2.close()
    })

    it("should return null for unknown peer", async () => {
        const { ws } = await registerPeer("aa".repeat(32))

        sendFrame(ws, "request_public_key", { targetId: "unknown" })
        const resp = await waitForMessage(ws, "public_key_response")
        expect((resp.payload as any).publicKey).toBeNull()

        ws.close()
    })
})

describe("Integration: Disconnect", () => {
    it("should notify peers when someone disconnects", async () => {
        const { ws: ws1 } = await registerPeer("aa".repeat(32))
        const { ws: ws2 } = await registerPeer("bb".repeat(32))

        const leftPromise = waitForMessage(ws1, "peer_left")
        await close(ws2)
        const notification = await leftPromise
        expect((notification.payload as any).publicKey).toBe("bb".repeat(32))

        ws1.close()
    })
})

describe("Integration: Error Handling", () => {
    it("should reject invalid JSON", async () => {
        const ws = await connect()
        ws.send("not json at all {{{")
        const resp = await waitForMessage(ws, "error")
        expect((resp.payload as any).code).toBe("INVALID_MESSAGE")
        ws.close()
    })

    it("should reject unknown message type", async () => {
        const ws = await connect()
        sendFrame(ws, "banana", {})
        const resp = await waitForMessage(ws, "error")
        expect((resp.payload as any).code).toBe("INVALID_MESSAGE")
        expect((resp.payload as any).message).toContain("banana")
        ws.close()
    })

    it("should reject message without type", async () => {
        const ws = await connect()
        ws.send(JSON.stringify({ payload: {} }))
        const resp = await waitForMessage(ws, "error")
        expect((resp.payload as any).code).toBe("INVALID_MESSAGE")
        ws.close()
    })
})

describe("Integration: Concurrent Operations", () => {
    it("should handle multiple simultaneous registrations", async () => {
        const results = await Promise.all(
            Array.from({ length: 5 }, (_, i) => {
                const key = (i.toString(16).padStart(2, "0")).repeat(32)
                return registerPeer(key)
            })
        )
        expect(results.length).toBe(5)
        for (const { resp } of results) {
            expect((resp.payload as any).success).toBe(true)
        }
        for (const { ws } of results) ws.close()
    })

    it("should handle rapid message sends", async () => {
        const { ws: sender } = await registerPeer("aa".repeat(32))
        const { ws: recipient } = await registerPeer("bb".repeat(32))

        const count = 10
        const allReceived = collectMessages(recipient, count)

        for (let i = 0; i < count; i++) {
            sendFrame(sender, "send", {
                to: "bb".repeat(32),
                encrypted: { ciphertext: `msg_${i}`, nonce: "n" },
                messageHash: `hash_${i}`,
            })
        }

        const received = await allReceived
        const messages = received.filter(m => m.type === "message")
        expect(messages.length).toBe(count)

        sender.close()
        recipient.close()
    })
})
