/**
 * The relay is a public endpoint and registration needs only a key, so what
 * one socket, one address or one subnet can cost the others is bounded here:
 * registration rate, queued rows per recipient, frame size and reply size.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "bun:test"
import { sign } from "node:crypto"
import {
    Client,
    encrypted,
    historyRows,
    identity,
    orderings,
    proofFor,
    register,
    relay,
    resetRelay,
    rows,
    sendAndWait,
    service,
    startRelayServer,
    stopRelayServer,
    submitToL2PS,
} from "./relayHarness"

// After the harness: importing the server first would load the real datasource.
const { MAX_TRACKED_ADDRESSES } = await import("../L2PSMessagingServer")

beforeAll(startRelayServer)
afterAll(stopRelayServer)
beforeEach(resetRelay)

const REAL_NOW = Date.now
afterEach(() => {
    Date.now = REAL_NOW
    delete process.env.L2PS_MESSAGING_TRUST_PROXY
})
const advance = (ms: number) => {
    Date.now = () => REAL_NOW() + ms
}
const limiter = () => (relay.server as any).registerByAddress as {
    size: number
    take(key: string, now: number): number
    windows: Map<string, unknown>
}

// ─── Registration rate ───────────────────────────────────────────

describe("registration is rate limited before any signature is checked", () => {
    it("a socket over its register rate is refused with a retry hint, and may register again after the window", async () => {
        const id = identity()
        const client = await Client.open()
        const attempt = async (offset: number) => {
            const ts = Date.now() + offset
            client.frame("register", { publicKey: id.publicKey, l2psUid: "subnet_a", proof: proofFor(id, ts) }, ts)
            return client.next("registered")
        }
        for (let i = 0; i < 5; i++) expect((await attempt(i)).type).toBe("registered")

        const refused = await attempt(5)
        expect(refused.type).toBe("error")
        expect(refused.payload.code).toBe("RATE_LIMITED")
        expect(refused.payload.retryAfterMs).toBeGreaterThan(0)
        expect(refused.payload.retryAfterMs).toBeLessThanOrEqual(10_000)

        advance(11_000)
        expect((await attempt(6)).type).toBe("registered")
        client.close()
    })

    it("a rate-limited frame never reaches the signature check", async () => {
        const client = await Client.open()
        const bad = { publicKey: identity().publicKey, l2psUid: "subnet_a", proof: "ab".repeat(64) }
        const codes: string[] = []
        for (let i = 0; i < 7; i++) {
            client.frame("register", bad)
            codes.push((await client.next("registered")).payload.code)
        }
        expect(codes.slice(0, 5)).toEqual(Array(5).fill("INVALID_PROOF"))
        expect(codes.slice(5)).toEqual(["RATE_LIMITED", "RATE_LIMITED"])
        client.close()
    })

    it("an address over its rate is refused across sockets, failed proofs included, and recovers after the window", async () => {
        const codes: string[] = []
        // Twenty bad proofs, then ten good ones: all thirty count.
        for (let i = 0; i < 30; i++) {
            const client = await Client.open()
            const id = identity()
            const ts = Date.now()
            const proof = i < 20 ? "ab".repeat(64) : proofFor(id, ts)
            client.frame("register", { publicKey: id.publicKey, l2psUid: "subnet_a", proof }, ts)
            codes.push((await client.next("registered")).payload?.code ?? "ok")
            client.close()
        }
        expect(codes.filter(c => c === "INVALID_PROOF")).toHaveLength(20)
        expect(codes.filter(c => c === "ok")).toHaveLength(10)

        const over = await register(identity())
        expect(over.reply.payload.code).toBe("RATE_LIMITED")
        expect(over.reply.payload.retryAfterMs).toBeGreaterThan(0)
        over.client.close()

        advance(61_000)
        const later = await register(identity())
        expect(later.reply.type).toBe("registered")
        later.client.close()
    })

    it("the table of tracked addresses stays within its bound", () => {
        const now = Date.now()
        for (let i = 0; i < MAX_TRACKED_ADDRESSES + 500; i++) limiter().take(`10.0.${i >> 8}.${i & 255}/${i}`, now)
        expect(limiter().size).toBeLessThanOrEqual(MAX_TRACKED_ADDRESSES)
        // The newest address is still counted; only the oldest were forgotten.
        expect(limiter().windows.has(`10.0.${(MAX_TRACKED_ADDRESSES + 499) >> 8}.${(MAX_TRACKED_ADDRESSES + 499) & 255}/${MAX_TRACKED_ADDRESSES + 499}`)).toBe(true)
    })

    const withForwardedFor = async (header: string) => {
        const ws = new WebSocket(`ws://localhost:${relay.port}`, { headers: { "x-forwarded-for": header } } as any)
        await new Promise((resolve, reject) => {
            ws.addEventListener("open", resolve)
            ws.addEventListener("error", reject)
        })
        const client = new Client(ws)
        const id = identity()
        client.frame("register", { publicKey: id.publicKey, l2psUid: "subnet_a", proof: proofFor(id, Date.now()) })
        await client.next("registered")
        client.close()
    }

    it("ignores x-forwarded-for unless the relay is told it sits behind a proxy", async () => {
        await withForwardedFor("198.51.100.7, 203.0.113.9")
        expect(limiter().windows.has("203.0.113.9")).toBe(false)
        expect(limiter().windows.has("198.51.100.7")).toBe(false)
        expect(limiter().size).toBe(1)
    })

    it("keys on the hop the trusted proxy appended, not on what the client claimed", async () => {
        process.env.L2PS_MESSAGING_TRUST_PROXY = "true"
        await withForwardedFor("198.51.100.7, 203.0.113.9")
        expect(limiter().windows.has("203.0.113.9")).toBe(true)
        expect(limiter().windows.has("198.51.100.7")).toBe(false)
    })
})

// ─── Recipient queue ─────────────────────────────────────────────

const queuedRow = (n: number, toKey: string, extra: Record<string, unknown> = {}) => ({
    id: `row-${n}`,
    l2psUid: "subnet_a",
    fromKey: `f${n}`.padEnd(64, "0"),
    toKey,
    messageHash: `h${n}`,
    encrypted,
    l2psTxHash: "0xtx",
    timestamp: String(1_000_000 + n),
    status: "queued",
    ...extra,
})

describe("a recipient's queue is bounded", () => {
    const fillQueue = (toKey: string, count: number) => {
        for (let i = 0; i < count; i++) rows.set(`row-${i}`, queuedRow(i, toKey))
    }

    it("queued rows above the recipient cap are refused with QUEUE_FULL and nothing is stored", async () => {
        const sender = identity()
        const victim = identity()
        fillQueue(victim.publicKey, 1_000)
        const s = await register(sender)

        const reply = await sendAndWait(s.client, victim, "one-too-many")
        expect(reply.type).toBe("error")
        expect(reply.payload.code).toBe("QUEUE_FULL")
        expect(rows.size).toBe(1_000)
        expect(service.offlineMessageCounts.get(sender.publicKey) ?? 0).toBe(0)

        // Another recipient is not affected.
        expect((await sendAndWait(s.client, identity(), "elsewhere")).type).toBe("message_queued")
        s.client.close()
    })

    it("an online recipient is not subject to the queue cap", async () => {
        const sender = identity()
        const victim = identity()
        fillQueue(victim.publicKey, 1_000)
        const s = await register(sender)
        const v = await register(victim)
        await v.client.next("message") // delivery of the first page of the backlog
        expect((await sendAndWait(s.client, victim, "live")).type).toBe("message_sent")
        s.client.close()
        v.client.close()
    })

    it("a requeue into a full queue is refused and the row is left failed, so the sender can retry", async () => {
        const victim = identity()
        fillQueue(victim.publicKey, 1_000)
        rows.set("late", queuedRow(5_000, victim.publicKey, { id: "late", status: "delivered" }))

        expect(await service.requeue("late", "ff".repeat(32))).toBe(false)
        expect(rows.get("late")!.status).toBe("failed")
        expect(service.heldSlots.has("late")).toBe(false)
    })

    it("a requeue below the cap still queues the row and takes a slot", async () => {
        const victim = identity()
        rows.set("late", queuedRow(1, victim.publicKey, { id: "late", status: "delivered" }))

        expect(await service.requeue("late", "ff".repeat(32))).toBe(true)
        expect(rows.get("late")!.status).toBe("queued")
        expect(service.heldSlots.has("late")).toBe(true)
        service.releaseSlot("late")
    })
})

describe("a submitted message is never submitted twice", () => {
    it("a resend after a requeue hit the recipient cap retries delivery only, with the original tx hash", async () => {
        const victim = identity()
        const from = "ff".repeat(32)
        const sent = await service.processMessage(from, victim.publicKey, "subnet_a", "msg-1", "h-1", encrypted, true)
        expect(sent.success).toBe(true)
        expect(sent.l2psTxHash).toBe("0xtx")

        for (let i = 0; i < 1_000; i++) rows.set(`row-${i}`, queuedRow(i, victim.publicKey))
        expect(await service.requeue("msg-1", from)).toBe(false)
        expect(rows.get("msg-1")!.status).toBe("failed")
        expect(rows.get("msg-1")!.l2psTxHash).toBe("0xtx")

        // Still full: refused, row untouched.
        const full = await service.processMessage(from, victim.publicKey, "subnet_a", "msg-2", "h-1", encrypted, false)
        expect(full.success).toBe(false)
        expect(full.code).toBe("QUEUE_FULL")
        expect(rows.get("msg-1")!.status).toBe("failed")

        for (let i = 0; i < 1_000; i++) rows.delete(`row-${i}`)
        const again = await service.processMessage(from, victim.publicKey, "subnet_a", "msg-3", "h-1", encrypted, false)

        expect(again.success).toBe(true)
        expect(again.duplicate).toBeUndefined()
        expect(again.messageId).toBe("msg-1")
        expect(again.l2psTxHash).toBe("0xtx")
        expect(again.status).toBe("queued")
        expect(rows.size).toBe(1)
        expect(rows.get("msg-1")!.status).toBe("queued")
        expect(rows.get("msg-1")!.l2psTxHash).toBe("0xtx")
        expect(submitToL2PS).toHaveBeenCalledTimes(1)
        expect(service.heldSlots.get("msg-1")).toBe(from)
        service.releaseSlot("msg-1")
    })

    it("a resend to a recipient who is online again is delivered, still without a second submission", async () => {
        const victim = identity()
        const from = "ff".repeat(32)
        await service.processMessage(from, victim.publicKey, "subnet_a", "msg-1", "h-1", encrypted, true)
        rows.get("msg-1")!.status = "failed"

        const again = await service.processMessage(from, victim.publicKey, "subnet_a", "msg-2", "h-1", encrypted, true)

        expect(again.success).toBe(true)
        expect(again.status).toBe("delivered")
        expect(again.l2psTxHash).toBe("0xtx")
        expect(submitToL2PS).toHaveBeenCalledTimes(1)
        expect(rows.size).toBe(1)
    })

    it("a retry with a changed envelope delivers the one that was submitted", async () => {
        const victim = identity()
        const from = "ff".repeat(32)
        await service.processMessage(from, victim.publicKey, "subnet_a", "msg-1", "h-1", encrypted, true)
        rows.get("msg-1")!.status = "failed"
        const changed = { ciphertext: Buffer.from("other").toString("base64"), nonce: encrypted.nonce }

        const again = await service.processMessage(from, victim.publicKey, "subnet_a", "msg-2", "h-1", changed, true)

        expect(again.success).toBe(true)
        expect(again.encrypted).toEqual(encrypted)
        expect(rows.get("msg-1")!.encrypted).toEqual(encrypted)
    })

    it("a failed row that was never submitted is still submitted on retry", async () => {
        const victim = identity()
        const from = "ff".repeat(32)
        relay.submitResult = { success: false, error: "mempool unavailable" }
        await service.processMessage(from, victim.publicKey, "subnet_a", "msg-1", "h-1", encrypted, true)
        relay.submitResult = { success: true, txHash: "0xtx2" }

        const again = await service.processMessage(from, victim.publicKey, "subnet_a", "msg-2", "h-1", encrypted, true)

        expect(again.l2psTxHash).toBe("0xtx2")
        expect(submitToL2PS).toHaveBeenCalledTimes(2)
    })
})

describe("queued delivery is paged", () => {
    it("250 queued rows are delivered in pages of 100, marked per page, in order", async () => {
        const victim = identity()
        for (let i = 0; i < 250; i++) rows.set(`row-${i}`, queuedRow(i, victim.publicKey))
        const fetched = jest.spyOn(service, "getQueuedMessages")
        const marked = jest.spyOn(service, "markDelivered")

        const r = await register(victim)
        const hashes: string[] = []
        for (let i = 0; i < 250; i++) hashes.push((await r.client.next("message")).payload.messageHash)
        await Bun.sleep(50)

        expect(hashes).toEqual(Array.from({ length: 250 }, (_, i) => `h${i}`))
        expect(marked.mock.calls.map(c => (c[0] as string[]).length)).toEqual([100, 100, 50])
        expect(fetched.mock.calls.every(c => c[2] === 100)).toBe(true)
        expect([...rows.values()].every(row => row.status === "sent")).toBe(true)

        fetched.mockRestore()
        marked.mockRestore()
        r.client.close()
    })

    it("stops at the first failed send and leaves the rest queued", async () => {
        const victim = identity()
        for (let i = 0; i < 150; i++) rows.set(`row-${i}`, queuedRow(i, victim.publicKey))
        const marked = jest.spyOn(service, "markDelivered")
        const server = relay.server as any
        const original = server.send.bind(server)
        let sent = 0
        const send = jest.spyOn(server, "send").mockImplementation((ws: any, frame: any) =>
            frame.type === "message" && ++sent > 120 ? false : original(ws, frame))

        const r = await register(victim)
        await Bun.sleep(100)

        const left = [...rows.values()].filter(row => row.status === "queued")
        expect(left.length).toBe(30)
        expect(marked.mock.calls.map(c => (c[0] as string[]).length)).toEqual([100, 20])

        send.mockRestore()
        marked.mockRestore()
        r.client.close()
    })

    it("does not resend forever when the rows cannot be marked delivered", async () => {
        const victim = identity()
        for (let i = 0; i < 100; i++) rows.set(`row-${i}`, queuedRow(i, victim.publicKey))
        const marked = jest.spyOn(service, "markDelivered").mockImplementation(async () => {})
        const fetched = jest.spyOn(service, "getQueuedMessages")

        const r = await register(victim)
        await Bun.sleep(100)

        expect(fetched.mock.calls.length).toBe(2)
        fetched.mockRestore()
        marked.mockRestore()
        r.client.close()
    })
})

// ─── Frame size ──────────────────────────────────────────────────

describe("frame limits are enforced on bytes", () => {
    it("a frame above the payload limit closes the socket instead of being buffered", async () => {
        const client = await Client.open()
        const closed = new Promise<void>(resolve => client.ws.addEventListener("close", () => resolve()))
        client.ws.send("x".repeat(300 * 1024))
        await Promise.race([closed, Bun.sleep(2000).then(() => Promise.reject(new Error("socket stayed open")))])
    })

    it("a frame under the limit in characters but over it in bytes closes the socket", async () => {
        const id = identity()
        const s = await register(id)
        // 100k CJK characters are 300 KB: well under 256k characters, over 256 KB.
        const closed = new Promise<void>(resolve => s.client.ws.addEventListener("close", () => resolve()))
        s.client.ws.send(JSON.stringify({ type: "discover", payload: { pad: "漢".repeat(100_000) }, timestamp: Date.now() }))
        await Promise.race([closed, Bun.sleep(2000).then(() => Promise.reject(new Error("socket stayed open")))])
    })

    it("a messageHash of 2048 multi-byte characters exceeds the index row limit and is refused", async () => {
        const sender = identity()
        const s = await register(sender)
        s.client.frame("send", { to: identity().publicKey, encrypted, messageHash: "漢".repeat(2048) })
        const reply = await s.client.next(["message_sent", "message_queued"])
        expect(reply.type).toBe("error")
        expect(reply.payload.code).toBe("INVALID_MESSAGE")
        expect(rows.size).toBe(0)
        s.client.close()
    })
})

// ─── History ─────────────────────────────────────────────────────

describe("a history read needs a fresh proof and has a bounded reply", () => {
    const ask = async (timestamp: number) => {
        const me = identity()
        const peer = identity()
        const m = await register(me)
        const proof = sign(null, Buffer.from(`history:${peer.publicKey}:${timestamp}`), me.privateKey).toString("hex")
        m.client.frame("history", { peerKey: peer.publicKey, proof }, timestamp)
        const reply = await m.client.next("history_response")
        m.client.close()
        return reply
    }

    it("refuses a proof outside the clock window, in either direction", async () => {
        for (const offset of [-6 * 60_000, 6 * 60_000]) {
            const reply = await ask(Date.now() + offset)
            expect(reply.type).toBe("error")
            expect(reply.payload.code).toBe("INVALID_PROOF")
        }
    })

    it("accepts a proof inside the window", async () => {
        expect((await ask(Date.now() - 60_000)).type).toBe("history_response")
    })

    it("stops adding rows at the byte budget and says there is more", async () => {
        const big = "A".repeat(128 * 1024)
        for (let i = 0; i < 12; i++) {
            historyRows.push(queuedRow(i, "aa".repeat(32), { status: "sent", encrypted: { ciphertext: big, nonce: "n" } }))
        }
        const reply = await ask(Date.now())
        expect(reply.type).toBe("history_response")
        expect(reply.payload.messages).toHaveLength(8)
        expect(reply.payload.hasMore).toBe(true)
    })

    it("never cuts inside a group of rows that share a timestamp, so the next page cannot skip any", async () => {
        const big = { ciphertext: "A".repeat(128 * 1024), nonce: "n" }
        for (let i = 0; i < 9; i++) {
            historyRows.push(queuedRow(i, "aa".repeat(32), { timestamp: "5000", encrypted: big }))
        }
        const result = await service.getHistory("aa", "bb", "subnet_a")

        expect(result.messages.map((m: any) => m.id)).toEqual(Array.from({ length: 9 }, (_, i) => `row-${i}`))
        expect(result.hasMore).toBe(false)
    })

    it("runs a page past the budget only to the end of the group the cutoff landed in", async () => {
        const big = { ciphertext: "A".repeat(128 * 1024), nonce: "n" }
        for (let i = 0; i < 7; i++) historyRows.push(queuedRow(i, "aa".repeat(32), { timestamp: String(9000 - i), encrypted: big }))
        for (let i = 7; i < 10; i++) historyRows.push(queuedRow(i, "aa".repeat(32), { timestamp: "100", encrypted: big }))
        historyRows.push(queuedRow(10, "aa".repeat(32), { timestamp: "50", encrypted: big }))

        const result = await service.getHistory("aa", "bb", "subnet_a")

        expect(result.messages).toHaveLength(10)
        expect(result.messages.at(-1)!.timestamp).toBe(100)
        expect(result.hasMore).toBe(true)
    })

    it("orders history by timestamp and then id, both newest first", async () => {
        await service.getHistory("aa", "bb", "subnet_a")
        expect(orderings).toEqual(["m.timestamp DESC", "m.id DESC"])
    })

    it("always returns the first row, whatever its size, so a page is never empty", async () => {
        const huge = "A".repeat(2 * 1024 * 1024)
        historyRows.push(queuedRow(1, "aa".repeat(32), { encrypted: { ciphertext: huge, nonce: "n" } }))
        historyRows.push(queuedRow(2, "aa".repeat(32)))
        const result = await service.getHistory("aa", "bb", "subnet_a")
        expect(result.messages).toHaveLength(1)
        expect(result.hasMore).toBe(true)
    })
})
