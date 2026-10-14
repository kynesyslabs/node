/**
 * Hostile input to the messaging relay that carries RFQ traffic.
 *
 * The node only relays: it routes a bid or a quote between registered peers
 * and records it. What it has to hold is that a frame cannot make two
 * different messages look like one, cannot leave a sender worse off after a
 * failure, and cannot turn a malformed field into a crash or an unbounded read.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from "bun:test"
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto"

// ─── In-memory l2ps_messages ─────────────────────────────────────

type Row = Record<string, any>
const rows = new Map<string, Row>()
const faults: { save: Error | null; update: Error | null } = { save: null, update: null }
const tupleOf = (r: Row) => JSON.stringify([r.l2psUid, r.fromKey, r.toKey, r.messageHash])

const repo = {
    findOneBy: async (where: Row) =>
        [...rows.values()].find(r => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null,
    save: async (row: Row) => {
        if (faults.save) throw faults.save
        for (const r of rows.values()) {
            if (r.id !== row.id && tupleOf(r) === tupleOf(row)) {
                throw Object.assign(new Error("duplicate key"), { code: "23505" })
            }
        }
        rows.set(row.id, { ...row })
        return row
    },
    update: async (criteria: string | string[] | Row, patch: Row) => {
        if (faults.update) throw faults.update
        const matches = typeof criteria === "string" || Array.isArray(criteria)
            ? [criteria].flat().map(id => rows.get(id)).filter(Boolean) as Row[]
            : [...rows.values()].filter(r => Object.entries(criteria).every(([k, v]) => r[k] === v))
        for (const r of matches) Object.assign(r, patch)
        return { affected: matches.length }
    },
    delete: async (id: string) => {
        rows.delete(id)
    },
    find: async () => [],
    createQueryBuilder: () => {
        const qb: any = {
            where: () => qb,
            andWhere: (_clause: string, params: unknown) => {
                conditions.push(params)
                return qb
            },
            orderBy: () => qb,
            take: (n: unknown) => {
                queryTake.push(n)
                return qb
            },
            getMany: async () => [],
        }
        return qb
    },
}
const queryTake: unknown[] = []
const conditions: unknown[] = []

const SUBNETS = new Set(["subnet_a", "subnet_b"])

jest.mock("@/model/datasource", () => ({
    __esModule: true,
    dataSource: { getRepository: () => repo },
    default: { getInstance: async () => ({ getDataSource: () => ({ getRepository: () => repo }) }) },
}))
jest.mock("@/libs/l2ps/parallelNetworks", () => ({
    __esModule: true,
    default: { getInstance: () => ({ getL2PS: async (uid: string) => (SUBNETS.has(uid) ? {} : null) }) },
}))
jest.mock("@/libs/blockchain/transaction", () => ({ __esModule: true, default: class {} }))
jest.mock("@/libs/blockchain/l2ps_mempool", () => ({ __esModule: true, default: {} }))
jest.mock("@/libs/l2ps/L2PSTransactionExecutor", () => ({ __esModule: true, default: {} }))
jest.mock("@/utilities/sharedState", () => ({ getSharedState: { signingAlgorithm: "ed25519" } }))

const { L2PSMessagingService } = await import("../L2PSMessagingService")
const { L2PSMessagingServer } = await import("../L2PSMessagingServer")

const service = L2PSMessagingService.getInstance() as any
let submitResult: { success: boolean; txHash?: string; error?: string } = { success: true, txHash: "0xtx" }
// The service is a process-wide singleton shared with other test files.
const submitToL2PS = jest.spyOn(service, "submitToL2PS").mockImplementation(async () => submitResult)

// ─── Keys and sockets ────────────────────────────────────────────

interface Identity {
    publicKey: string
    privateKey: KeyObject
}

function identity(): Identity {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519")
    const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url")
    return { publicKey: raw.toString("hex"), privateKey }
}

function proofFor(id: Identity, timestamp: number, l2psUid?: string): string {
    const message = l2psUid ? `register:${l2psUid}:${id.publicKey}:${timestamp}` : `register:${id.publicKey}:${timestamp}`
    return sign(null, Buffer.from(message), id.privateKey).toString("hex")
}

let server: InstanceType<typeof L2PSMessagingServer>
let port: number

beforeAll(() => {
    port = 21000 + Math.floor(Math.random() * 2000)
    server = new L2PSMessagingServer(port)
})

afterAll(() => {
    server.stop()
    submitToL2PS.mockRestore()
})

beforeEach(() => {
    rows.clear()
    queryTake.length = 0
    conditions.length = 0
    submitToL2PS.mockImplementation(async () => submitResult)
    faults.save = null
    faults.update = null
    submitToL2PS.mockClear()
    submitResult = { success: true, txHash: "0xtx" }
})

class Client {
    private inbox: any[] = []
    private waiters: Array<() => void> = []
    constructor(readonly ws: WebSocket) {
        ws.addEventListener("message", e => {
            this.inbox.push(JSON.parse(e.data as string))
            this.waiters.splice(0).forEach(w => w())
        })
    }

    static async open(): Promise<Client> {
        const ws = new WebSocket(`ws://localhost:${port}`)
        await new Promise((resolve, reject) => {
            ws.addEventListener("open", resolve)
            ws.addEventListener("error", reject)
        })
        return new Client(ws)
    }

    frame(type: string, payload: Record<string, unknown>, timestamp = Date.now()): void {
        this.ws.send(JSON.stringify({ type, payload, timestamp }))
    }

    async next(type: string | string[], timeout = 2000): Promise<any> {
        const types = Array.isArray(type) ? type : [type]
        const deadline = Date.now() + timeout
        for (;;) {
            const i = this.inbox.findIndex(f => types.includes(f.type) || f.type === "error")
            if (i >= 0) return this.inbox.splice(i, 1)[0]
            if (Date.now() > deadline) throw new Error(`timeout waiting for ${type}`)
            await new Promise<void>(r => {
                this.waiters.push(r)
                setTimeout(r, 50)
            })
        }
    }

    has(type: string): boolean {
        return this.inbox.some(f => f.type === type)
    }

    close(): void {
        this.ws.close()
    }
}

async function register(id: Identity, l2psUid = "subnet_a", timestamp = Date.now(), proof?: string) {
    const client = await Client.open()
    client.frame("register", { publicKey: id.publicKey, l2psUid, proof: proof ?? proofFor(id, timestamp) }, timestamp)
    return { client, reply: await client.next("registered") }
}

const encrypted = { ciphertext: Buffer.from("quote").toString("base64"), nonce: Buffer.from("n").toString("base64") }

async function sendAndWait(from: Client, to: Identity, messageHash: string) {
    from.frame("send", { to: to.publicKey, encrypted, messageHash })
    return from.next(["message_sent", "message_queued"])
}


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

describe("a send that fails does not cost the sender quota", () => {
    it("when the row cannot be written", async () => {
        faults.save = new Error("connection terminated")
        await expect(
            service.processMessage("quota-a", "bb", "subnet_a", crypto.randomUUID(), "h1", encrypted, false),
        ).rejects.toThrow()

        expect(quotaOf("quota-a")).toBe(0)
    })

    it("when the status of a failed submission cannot be written", async () => {
        submitResult = { success: false, error: "mempool unavailable" }
        faults.update = new Error("connection terminated")
        await expect(
            service.processMessage("quota-b", "bb", "subnet_a", crypto.randomUUID(), "h2", encrypted, false),
        ).rejects.toThrow()

        expect(quotaOf("quota-b")).toBe(0)
    })

    it("two hundred transient failures do not lock the sender out", async () => {
        faults.save = new Error("connection terminated")
        for (let i = 0; i < 205; i++) {
            await service.processMessage("quota-c", "bb", "subnet_a", crypto.randomUUID(), `h${i}`, encrypted, false).catch(() => {})
        }
        faults.save = null

        const ok = await service.processMessage("quota-c", "bb", "subnet_a", crypto.randomUUID(), "fresh", encrypted, false)
        expect(ok.success).toBe(true)
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

    it.each([
        [{ limit: 1e9 }, 201],
        [{ limit: Number.MAX_SAFE_INTEGER }, 201],
        [{ limit: -5 }, 2],
        [{ limit: 0 }, 2],
        [{ limit: "5" }, 51],
        [{ limit: "abc" }, 51],
        [{ limit: 2.5 }, 3],
        [{ limit: null }, 51],
        [{ limit: {} }, 51],
    ])("limit %j reaches the query as take %p", async (extra, take) => {
        const me = identity()
        const peer = identity()
        const m = await register(me)
        const { payload, ts } = historyFrame(me, peer.publicKey, extra)
        m.client.frame("history", payload, ts)
        const reply = await m.client.next("history_response")

        expect(reply.type).toBe("history_response")
        expect(queryTake).toEqual([take])
        m.client.close()
    })

    it.each([[{ before: "abc" }], [{ before: {} }], [{ before: [1] }], [{ before: "1; DROP TABLE" }], [{ before: -1 }], [{ before: 1e308 }]])(
        "before %j does not fail the read",
        async extra => {
            const me = identity()
            const peer = identity()
            const m = await register(me)
            const { payload, ts } = historyFrame(me, peer.publicKey, extra)
            m.client.frame("history", payload, ts)
            const reply = await m.client.next("history_response")

            expect(reply.type).toBe("history_response")
            for (const condition of conditions as Array<{ before?: string }>) {
                if ("before" in condition) expect(condition.before).toMatch(/^[0-9]{1,15}$/)
            }
            m.client.close()
        },
    )

    it("a oversized hash is refused", async () => {
        const sender = identity()
        const recipient = identity()
        const s = await register(sender)
        s.client.frame("send", { to: recipient.publicKey, encrypted, messageHash: "h".repeat(2000) })
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
