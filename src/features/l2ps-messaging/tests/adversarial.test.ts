/**
 * Hostile input to the messaging relay that carries RFQ traffic.
 *
 * The node only relays: it routes a bid or a quote between registered peers
 * and records it. What it has to hold is that a frame cannot make two
 * different messages look like one, cannot leave a sender worse off after a
 * failure, and cannot turn a malformed field into a crash or an unbounded read.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import {
    Client,
    conditions,
    encrypted,
    faults,
    identity,
    proofFor,
    queryTake,
    register,
    relay,
    resetRelay,
    rows,
    sendAndWait,
    service,
    startRelayServer,
    stopRelayServer,
    submitToL2PS,
    type Identity,
} from "./relayHarness"
import { sign } from "node:crypto"

beforeAll(startRelayServer)
afterAll(stopRelayServer)
beforeEach(resetRelay)

const quotaOf = (key: string): number => service.offlineMessageCounts.get(key) ?? 0

// ─── Message identity ────────────────────────────────────────────

describe("two different messages never share an identity", () => {
    it("a recipient or hash that carries the key delimiter does not merge two sends in flight", async () => {
        const gates: Array<(r: { success: boolean; txHash?: string }) => void> = []
        submitToL2PS.mockImplementation(() => new Promise(resolve => gates.push(resolve)))

        // "aa|bb" + "cc" and "aa" + "bb|cc" join to the same string.
        const first = service.processMessage("ff", "aa|bb", "subnet_a", crypto.randomUUID(), "cc", encrypted, true)
        const second = service.processMessage("ff", "aa", "subnet_a", crypto.randomUUID(), "bb|cc", encrypted, true)
        await Bun.sleep(30)

        expect(submitToL2PS).toHaveBeenCalledTimes(2)
        gates.forEach(g => g({ success: true, txHash: "0xtx" }))
        const results = await Promise.all([first, second])
        expect(results.map((r: any) => r.duplicate)).toEqual([undefined, undefined])
        expect([...rows.values()]).toHaveLength(2)
    })

    it("the sender's key spelling does not make one message two", async () => {
        const gate: Array<(r: { success: boolean; txHash?: string }) => void> = []
        submitToL2PS.mockImplementationOnce(() => new Promise(resolve => gate.push(resolve)))

        const a = service.processMessage("0xAABB", "ccdd", "subnet_a", crypto.randomUUID(), "h", encrypted, true)
        await Bun.sleep(20)
        const b = service.processMessage("aabb", "0XCCDD", "subnet_a", crypto.randomUUID(), "h", encrypted, true)
        await Bun.sleep(20)
        gate[0]({ success: true, txHash: "0xtx" })

        const [r1, r2] = await Promise.all([a, b])
        expect(r1.duplicate).toBeUndefined()
        expect(r2.duplicate).toBe(true)
        expect(submitToL2PS).toHaveBeenCalledTimes(1)
    })

    it("the same hash from two senders to one recipient is two messages", async () => {
        const [r1, r2] = await Promise.all([
            service.processMessage("aa", "cc", "subnet_a", crypto.randomUUID(), "h", encrypted, true),
            service.processMessage("bb", "cc", "subnet_a", crypto.randomUUID(), "h", encrypted, true),
        ])
        expect(r1.duplicate).toBeUndefined()
        expect(r2.duplicate).toBeUndefined()
        expect([...rows.values()]).toHaveLength(2)
    })

    it("the same hash on two subnets is two messages", async () => {
        const [r1, r2] = await Promise.all([
            service.processMessage("aa", "cc", "subnet_a", crypto.randomUUID(), "h", encrypted, true),
            service.processMessage("aa", "cc", "subnet_b", crypto.randomUUID(), "h", encrypted, true),
        ])
        expect(r1.duplicate).toBeUndefined()
        expect(r2.duplicate).toBeUndefined()
    })

    it("a message whose hash only differs in case is a different message", async () => {
        const r1 = await service.processMessage("aa", "cc", "subnet_a", crypto.randomUUID(), "Hash", encrypted, true)
        const r2 = await service.processMessage("aa", "cc", "subnet_a", crypto.randomUUID(), "hash", encrypted, true)
        expect(r1.duplicate).toBeUndefined()
        expect(r2.duplicate).toBeUndefined()
    })
})

// ─── What a failure leaves behind ────────────────────────────────

describe("the offline quota follows the queued row", () => {
    const queuedFor = (sender: string) =>
        [...rows.values()].filter(r => r.fromKey === sender && r.status === "queued").length
    const send = (sender: string, hash: string) =>
        service.processMessage(sender, "bb", "subnet_a", crypto.randomUUID(), hash, encrypted, false)

    it("a row that cannot be written holds no slot", async () => {
        faults.save = new Error("connection terminated")
        await expect(send("quota-a", "h1")).rejects.toThrow()

        expect(quotaOf("quota-a")).toBe(0)
        expect(rows.size).toBe(0)
    })

    it("two hundred transient write failures do not lock the sender out", async () => {
        faults.save = new Error("connection terminated")
        for (let i = 0; i < 205; i++) await send("quota-c", `h${i}`).catch(() => {})
        faults.save = null

        expect((await send("quota-c", "fresh")).success).toBe(true)
    })

    it("a failed submission releases the slot and leaves the row failed", async () => {
        relay.submitResult = { success: false, error: "mempool unavailable" }
        const result = await send("quota-d", "h3")

        expect(result.success).toBe(false)
        expect(quotaOf("quota-d")).toBe(0)
        expect([...rows.values()].map(r => r.status)).toEqual(["failed"])
    })

    it("when the update to failed throws, the row is still queued and keeps its slot", async () => {
        relay.submitResult = { success: false, error: "mempool unavailable" }
        faults.update = patch => (patch.status === "failed" ? new Error("connection terminated") : null)
        await expect(send("quota-b", "h2")).rejects.toThrow()

        expect([...rows.values()].map(r => r.status)).toEqual(["queued"])
        expect(quotaOf("quota-b")).toBe(queuedFor("quota-b"))
        expect(quotaOf("quota-b")).toBe(1)
    })

    it("when the update after a successful submit throws, the queued row keeps its slot", async () => {
        faults.update = patch => (patch.l2psTxHash ? new Error("connection terminated") : null)
        await expect(send("quota-e", "h4")).rejects.toThrow()

        expect(submitToL2PS).toHaveBeenCalledTimes(1)
        expect([...rows.values()].map(r => r.status)).toEqual(["queued"])
        expect(quotaOf("quota-e")).toBe(1)
    })

    it("delivering that row frees its slot exactly once and spares the sender's other messages", async () => {
        faults.update = patch => (patch.l2psTxHash ? new Error("connection terminated") : null)
        await expect(send("quota-f", "h5")).rejects.toThrow()
        faults.update = null
        expect((await send("quota-f", "h6")).success).toBe(true)
        expect(quotaOf("quota-f")).toBe(2)

        const broken = [...rows.values()].find(r => r.messageHash === "h5")!
        await service.markDelivered([broken.id])
        expect(quotaOf("quota-f")).toBe(1)
        expect(queuedFor("quota-f")).toBe(1)

        await service.markDelivered([broken.id])
        expect(quotaOf("quota-f")).toBe(1)
    })

    it("a write that commits but loses its reply frees the slot once, however the row is delivered", async () => {
        faults.save = new Error("connection terminated")
        faults.lostReply = true
        await expect(send("quota-h", "lost-1")).rejects.toThrow()
        faults.save = null
        faults.lostReply = false

        // The row is there although the caller was told the write failed.
        const lost = [...rows.values()].find(r => r.messageHash === "lost-1")!
        expect(lost.status).toBe("queued")
        expect(quotaOf("quota-h")).toBe(0)

        expect((await send("quota-h", "kept")).success).toBe(true)
        expect(quotaOf("quota-h")).toBe(1)

        await service.markDelivered([lost.id])
        expect(quotaOf("quota-h")).toBe(1)
        await service.markDelivered([lost.id])
        expect(quotaOf("quota-h")).toBe(1)
    })

    it("a retry write that commits but loses its reply frees the slot once", async () => {
        relay.submitResult = { success: false, error: "mempool unavailable" }
        await send("quota-i", "lost-2")
        relay.submitResult = { success: true, txHash: "0xtx" }
        expect((await send("quota-i", "kept-2")).success).toBe(true)
        expect(quotaOf("quota-i")).toBe(1)

        faults.update = patch => (patch.status === "queued" ? new Error("connection terminated") : null)
        faults.lostReply = true
        await expect(send("quota-i", "lost-2")).rejects.toThrow()
        faults.update = null
        faults.lostReply = false

        const row = [...rows.values()].find(r => r.messageHash === "lost-2")!
        expect(row.status).toBe("queued")
        expect(quotaOf("quota-i")).toBe(1)

        await service.markDelivered([row.id])
        expect(quotaOf("quota-i")).toBe(1)
    })

    it("a repeated requeue of one row holds one slot", async () => {
        const sent = await service.processMessage("quota-j", "bb", "subnet_a", crypto.randomUUID(), "rq", encrypted, true)
        await service.requeue(sent.messageId, "quota-j")
        await service.requeue(sent.messageId, "quota-j")

        expect(quotaOf("quota-j")).toBe(1)
        await service.markDelivered([sent.messageId])
        expect(quotaOf("quota-j")).toBe(0)
    })

    it("a retry of the failed row takes a slot again and releases it with the row", async () => {
        relay.submitResult = { success: false, error: "mempool unavailable" }
        await send("quota-g", "h7")
        expect(quotaOf("quota-g")).toBe(0)

        relay.submitResult = { success: true, txHash: "0xtx" }
        const retried = await send("quota-g", "h7")
        expect(retried.success).toBe(true)
        expect(quotaOf("quota-g")).toBe(1)
        expect(queuedFor("quota-g")).toBe(1)

        await service.markDelivered([retried.messageId])
        expect(quotaOf("quota-g")).toBe(0)
    })
})

// ─── Malformed frames ────────────────────────────────────────────

describe("a malformed send is refused as a bad message", () => {
    const bad: Array<[string, (to: string) => Record<string, unknown>]> = [
        ["a numeric recipient", () => ({ to: 5, encrypted, messageHash: "h" })],
        ["an object recipient", () => ({ to: {}, encrypted, messageHash: "h" })],
        ["an array recipient", to => ({ to: [to], encrypted, messageHash: "h" })],
        ["a numeric hash", to => ({ to, encrypted, messageHash: 12345 })],
        ["an object hash", to => ({ to, encrypted, messageHash: { a: 1 } })],
        ["an array hash", to => ({ to, encrypted, messageHash: ["h"] })],
        ["a string as the envelope", to => ({ to, encrypted: "abc", messageHash: "h" })],
        ["an object ciphertext", to => ({ to, encrypted: { ciphertext: { length: 1 }, nonce: "n" }, messageHash: "h" })],
        ["an array nonce", to => ({ to, encrypted: { ciphertext: "c", nonce: ["n"] }, messageHash: "h" })],
    ]

    it.each(bad)("%s", async (_name, build) => {
        const sender = identity()
        const recipient = identity()
        const s = await register(sender)

        s.client.frame("send", build(recipient.publicKey))
        const reply = await s.client.next(["message_sent", "message_queued"])

        expect(reply.type).toBe("error")
        expect(reply.payload.code).toBe("INVALID_MESSAGE")
        expect(rows.size).toBe(0)
        expect(submitToL2PS).not.toHaveBeenCalled()

        const ok = await sendAndWait(s.client, recipient, "after-bad")
        expect(ok.type).toBe("message_queued")
        s.client.close()
    })

    it.each([
        ["the upper-case form of its own key", (k: string) => k.toUpperCase()],
        ["its own key with a 0x prefix", (k: string) => "0x" + k],
        ["its own key with a 0X prefix and upper case", (k: string) => "0X" + k.toUpperCase()],
    ])("a send to %s is a send to itself", async (_n, spell) => {
        const sender = identity()
        const s = await register(sender)

        s.client.frame("send", { to: spell(sender.publicKey), encrypted, messageHash: "self" })
        const reply = await s.client.next(["message_sent", "message_queued"])

        expect(reply.type).toBe("error")
        expect(rows.size).toBe(0)
        s.client.close()
    })

    it.each([
        ["a numeric key", { publicKey: 5, l2psUid: "subnet_a", proof: "00" }],
        ["an object key", { publicKey: {}, l2psUid: "subnet_a", proof: "00" }],
        ["an object subnet", { publicKey: "ab".repeat(32), l2psUid: {}, proof: "00" }],
        ["a numeric proof", { publicKey: "ab".repeat(32), l2psUid: "subnet_a", proof: 12 }],
    ])("a register frame with %s", async (_n, payload) => {
        const client = await Client.open()
        client.frame("register", payload)
        const reply = await client.next("registered")

        expect(reply.type).toBe("error")
        expect(reply.payload.code).not.toBe("INTERNAL_ERROR")
        client.close()
    })
})

// ─── History reads ───────────────────────────────────────────────

describe("a history read is bounded and does not depend on the caller's types", () => {
    const historyFrame = (id: Identity, peer: string, extra: Record<string, unknown>) => {
        const ts = Date.now()
        return {
            payload: { peerKey: peer, proof: sign(null, Buffer.from(`history:${peer}:${ts}`), id.privateKey).toString("hex"), ...extra },
            ts,
        }
    }

    const readHistory = async (extra: Record<string, unknown>) => {
        const me = identity()
        const peer = identity()
        const m = await register(me)
        const { payload, ts } = historyFrame(me, peer.publicKey, extra)
        m.client.frame("history", payload, ts)
        const reply = await m.client.next("history_response")
        m.client.close()
        return reply
    }

    it.each([
        [{ limit: 1e9 }, 201],
        [{ limit: Number.MAX_SAFE_INTEGER }, 201],
        [{ limit: -5 }, 2],
        [{ limit: 0 }, 2],
        [{ limit: 2.5 }, 3],
        [{ limit: null }, 51],
        [{}, 51],
    ])("limit %j reaches the query as take %p", async (extra, take) => {
        const reply = await readHistory(extra)

        expect(reply.type).toBe("history_response")
        expect(queryTake).toEqual([take])
    })

    it.each([[{ limit: "5" }], [{ limit: "abc" }], [{ limit: "" }], [{ limit: {} }], [{ limit: [5] }], [{ limit: true }]])(
        "a non-numeric limit %j is an error, not a silent default",
        async extra => {
            const reply = await readHistory(extra)

            expect(reply.type).toBe("error")
            expect(reply.payload.code).toBe("INVALID_MESSAGE")
            expect(queryTake).toEqual([])
        },
    )

    it.each([
        [{ before: 1700000000000 }, "1700000000000"],
        [{ before: "1700000000000" }, "1700000000000"],
        [{ before: 999999999999999 }, "999999999999999"],
    ])("a cursor %j reaches the query as %p", async (extra, bound) => {
        const reply = await readHistory(extra)

        expect(reply.type).toBe("history_response")
        expect(conditions).toContainEqual({ before: bound })
    })

    it.each([[{ before: 0 }], [{ before: null }], [{}]])("%j reads the newest page", async extra => {
        const reply = await readHistory(extra)

        expect(reply.type).toBe("history_response")
        expect(conditions.some(c => "before" in (c as object))).toBe(false)
    })

    it.each([
        [{ before: "abc" }],
        [{ before: {} }],
        [{ before: [1] }],
        [{ before: "1; DROP TABLE" }],
        [{ before: -1 }],
        [{ before: 1e308 }],
        [{ before: 1.5 }],
        [{ before: "1.5" }],
        [{ before: 1e15 }],
        [{ before: true }],
        [{ before: "" }],
    ])("a malformed cursor %j is an error, not the newest page again", async extra => {
        const reply = await readHistory(extra)

        expect(reply.type).toBe("error")
        expect(reply.payload.code).toBe("INVALID_MESSAGE")
        expect(queryTake).toEqual([])
        expect(conditions).toEqual([])
    })

    it("a hash at the index row limit is accepted", async () => {
        const sender = identity()
        const recipient = identity()
        const s = await register(sender)
        s.client.frame("send", { to: recipient.publicKey, encrypted, messageHash: "ab".repeat(1024) })
        const reply = await s.client.next(["message_sent", "message_queued"])

        expect(reply.type).toBe("message_queued")
        s.client.close()
    })

    it("an oversized hash is refused", async () => {
        const sender = identity()
        const recipient = identity()
        const s = await register(sender)
        s.client.frame("send", { to: recipient.publicKey, encrypted, messageHash: "h".repeat(20_000) })
        const reply = await s.client.next(["message_sent", "message_queued"])

        expect(reply.payload.code).toBe("INVALID_MESSAGE")
        expect(rows.size).toBe(0)
        s.client.close()
    })

    it("a proof made for one peer does not read the conversation with another", async () => {
        const me = identity()
        const peerA = identity()
        const peerB = identity()
        const m = await register(me)
        const { payload, ts } = historyFrame(me, peerA.publicKey, {})
        m.client.frame("history", { ...payload, peerKey: peerB.publicKey }, ts)
        const reply = await m.client.next("history_response")

        expect(reply.type).toBe("error")
        expect(reply.payload.code).toBe("INVALID_PROOF")
        m.client.close()
    })

    it("a proof made by another key is refused", async () => {
        const me = identity()
        const thief = identity()
        const peer = identity()
        const m = await register(me)
        const { payload, ts } = historyFrame(thief, peer.publicKey, {})
        m.client.frame("history", payload, ts)
        const reply = await m.client.next("history_response")

        expect(reply.payload.code).toBe("INVALID_PROOF")
        m.client.close()
    })

    it("an unregistered socket reads nothing", async () => {
        const me = identity()
        const client = await Client.open()
        const { payload, ts } = historyFrame(me, "ab".repeat(32), {})
        client.frame("history", payload, ts)
        const reply = await client.next("history_response")

        expect(reply.payload.code).toBe("REGISTRATION_REQUIRED")
        client.close()
    })
})

// ─── Frames that are valid JSON but not frames ───────────────────

describe("a JSON value that is not an object is refused, and the socket stays usable", () => {
    it.each([
        ["null", "null"],
        ["a number", "5"],
        ["an array", "[]"],
        ["a string", '"register"'],
    ])("%s", async (_n, raw) => {
        const client = await Client.open()
        client.ws.send(raw)
        const reply = await client.next("registered")

        expect(reply.type).toBe("error")
        expect(reply.payload.code).toBe("INVALID_MESSAGE")

        const id = identity()
        client.frame("register", { publicKey: id.publicKey, l2psUid: "subnet_a", proof: proofFor(id, Date.now()) })
        expect((await client.next("registered")).type).toBe("registered")
        client.close()
    })
})

// ─── Field bounds that the storage layer would otherwise enforce ─

describe("a send with an oversized or malformed identity field is refused before storage", () => {
    it.each([
        ["a messageHash above the index row limit", (to: string) => ({ to, encrypted, messageHash: "a".repeat(2049) })],
        ["a recipient that is not hex", () => ({ to: "zz".repeat(32), encrypted, messageHash: "h" })],
        ["a recipient shorter than a key", () => ({ to: "ab".repeat(16), encrypted, messageHash: "h" })],
        ["a recipient longer than any key encoding", () => ({ to: "ab".repeat(200), encrypted, messageHash: "h" })],
    ])("%s", async (_name, build) => {
        const sender = identity()
        const recipient = identity()
        const s = await register(sender)

        s.client.frame("send", build(recipient.publicKey))
        const reply = await s.client.next(["message_sent", "message_queued"])

        expect(reply.type).toBe("error")
        expect(reply.payload.code).toBe("INVALID_MESSAGE")
        expect(rows.size).toBe(0)

        const ok = await sendAndWait(s.client, recipient, "a".repeat(2048))
        expect(ok.type).toBe("message_queued")
        s.client.close()
    })
})

// ─── Slot accounting across recipients ───────────────────────────

describe("delivery to one recipient frees only that recipient's slots", () => {
    it("the sender's message queued for another offline peer keeps its slot", async () => {
        const sender = identity()
        const first = identity()
        const second = identity()
        const s = await register(sender)

        expect((await sendAndWait(s.client, first, "to-first")).type).toBe("message_queued")
        expect((await sendAndWait(s.client, second, "to-second")).type).toBe("message_queued")
        expect(quotaOf(sender.publicKey)).toBe(2)

        const r = await register(second)
        const delivered = await r.client.next("message")
        expect(delivered.payload.messageHash).toBe("to-second")

        await new Promise(resolve => setTimeout(resolve, 50))
        expect(quotaOf(sender.publicKey)).toBe(1)
        const left = [...rows.values()].filter(row => row.status === "queued")
        expect(left.map(row => row.messageHash)).toEqual(["to-first"])

        r.client.close()
        s.client.close()
    })
})

// ─── Register proof memory ───────────────────────────────────────

describe("the register proof memory is bounded", () => {
    const proofs = () => (relay.server as any).usedRegisterProofs as Map<string, number>

    it("a full memory refuses new registrations instead of growing or forgetting", async () => {
        const far = Date.now() + 60 * 60 * 1000
        for (let i = 0; i < 50_000; i++) proofs().set(`subnet_a|${i}`, far)
        try {
            const blocked = await register(identity())
            expect(blocked.reply.type).toBe("error")
            expect(blocked.reply.payload.code).toBe("RATE_LIMITED")
            blocked.client.close()
        } finally {
            proofs().clear()
        }

        const ok = await register(identity())
        expect(ok.reply.type).toBe("registered")
        ok.client.close()
    })
})
