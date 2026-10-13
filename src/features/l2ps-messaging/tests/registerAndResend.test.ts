/**
 * The real messaging server and service, with the database and the L2PS
 * pipeline faked: register proofs cannot be replayed, a key can sit on
 * several subnets, and a message fanned out or resent under one hash is
 * accepted once per recipient and answered idempotently.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from "bun:test"
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto"

// ─── In-memory l2ps_messages ─────────────────────────────────────

type Row = Record<string, any>
const rows = new Map<string, Row>()
const tupleOf = (r: Row) => [r.l2psUid, r.fromKey, r.toKey, r.messageHash].join("|")

const repo = {
    findOneBy: async (where: Row) =>
        [...rows.values()].find(r => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null,
    save: async (row: Row) => {
        for (const r of rows.values()) {
            if (r.id !== row.id && tupleOf(r) === tupleOf(row)) {
                throw Object.assign(new Error("duplicate key"), { code: "23505" })
            }
        }
        rows.set(row.id, { ...row })
        return row
    },
    update: async (criteria: string | string[] | Row, patch: Row) => {
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
}

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

// ─── Registration ────────────────────────────────────────────────

describe("register proof", () => {
    it("accepts a fresh proof", async () => {
        const { client, reply } = await register(identity())
        expect(reply.type).toBe("registered")
        client.close()
    })

    it("refuses a proof outside the time window", async () => {
        // Well past the window, not on its edge: the node reads its clock a moment later.
        const stale = Date.now() - 10 * 60_000
        const { client, reply } = await register(identity(), "subnet_a", stale)
        expect(reply.type).toBe("error")
        expect(reply.payload.code).toBe("INVALID_PROOF")
        client.close()
    })

    it("refuses a replayed proof, so a captured one cannot take over the key", async () => {
        const owner = identity()
        const ts = Date.now()
        const proof = proofFor(owner, ts)
        const first = await register(owner, "subnet_a", ts, proof)
        expect(first.reply.type).toBe("registered")

        const replay = await register(owner, "subnet_a", ts, proof)
        expect(replay.reply.type).toBe("error")
        expect(replay.reply.payload.message).toContain("already used")
        first.client.close()
        replay.client.close()
    })

    it("refuses a re-encoded copy of an accepted proof", async () => {
        const owner = identity()
        const ts = Date.now()
        const proof = proofFor(owner, ts)
        const first = await register(owner, "subnet_a", ts, proof)
        expect(first.reply.type).toBe("registered")

        // A stray character decodes to the same bytes under a lenient decoder,
        // and would look like a new proof to a cache keyed on text.
        for (const variant of [proof + "0", proof + "00", "0x" + proof.toUpperCase()]) {
            const again = await register(owner, "subnet_a", ts, variant)
            expect(again.reply.type).toBe("error")
            expect(again.reply.payload.code).toBe("INVALID_PROOF")
            again.client.close()
        }
        first.client.close()
    })

    it("accepts the form that names the subnet, only for that subnet", async () => {
        const owner = identity()
        const ts = Date.now()
        const ok = await register(owner, "subnet_a", ts, proofFor(owner, ts, "subnet_a"))
        expect(ok.reply.type).toBe("registered")

        const elsewhere = await register(owner, "subnet_b", ts, proofFor(owner, ts, "subnet_a"))
        expect(elsewhere.reply.type).toBe("error")
        expect(elsewhere.reply.payload.code).toBe("INVALID_PROOF")
        ok.client.close()
        elsewhere.client.close()
    })

    it("lets one legacy proof register the key on two subnets", async () => {
        const owner = identity()
        const ts = Date.now()
        const proof = proofFor(owner, ts)
        const a = await register(owner, "subnet_a", ts, proof)
        const b = await register(owner, "subnet_b", ts, proof)
        expect(a.reply.type).toBe("registered")
        expect(b.reply.type).toBe("registered")
        a.client.close()
        b.client.close()
    })

    it("refuses a proof signed by another key", async () => {
        const owner = identity()
        const ts = Date.now()
        const { client, reply } = await register(owner, "subnet_a", ts, proofFor(identity(), ts))
        expect(reply.type).toBe("error")
        expect(reply.payload.code).toBe("INVALID_PROOF")
        client.close()
    })
})

// ─── Multi-subnet ────────────────────────────────────────────────

describe("one key on several subnets", () => {
    it("keeps both registrations and routes each subnet separately", async () => {
        const seller = identity()
        const buyer = identity()
        const onA = await register(seller, "subnet_a")
        const onB = await register(seller, "subnet_b")
        expect(onB.reply.type).toBe("registered")

        const buyerOnA = await register(buyer, "subnet_a")
        expect(buyerOnA.reply.payload.onlinePeers).toContain(seller.publicKey)

        const sent = await sendAndWait(buyerOnA.client, seller, "h-multi")
        expect(sent.type).toBe("message_sent")
        expect((await onA.client.next("message")).payload.messageHash).toBe("h-multi")
        expect(onB.client.has("message")).toBe(false)

        for (const c of [onA.client, onB.client, buyerOnA.client]) c.close()
    })
})

describe("re-registering a socket on another subnet", () => {
    it("leaves the old subnet: its peers see peer_left and stop routing to it", async () => {
        const mover = identity()
        const watcher = identity()
        const w = await register(watcher, "subnet_a")
        const m = await register(mover, "subnet_a")
        await w.client.next("peer_joined")

        const ts = Date.now() + 1
        m.client.frame("register", { publicKey: mover.publicKey, l2psUid: "subnet_b", proof: proofFor(mover, ts) }, ts)
        expect((await m.client.next("registered")).payload.l2psUid).toBe("subnet_b")
        expect((await w.client.next("peer_left")).payload.publicKey).toBe(mover.publicKey)

        const reply = await sendAndWait(w.client, mover, "h-moved")
        expect(reply.type).toBe("message_queued")
        await Bun.sleep(100)
        expect(m.client.has("message")).toBe(false)

        w.client.close()
        m.client.close()
    })
})

// ─── Fan-out and resend ──────────────────────────────────────────

describe("messageHash scope", () => {
    it("accepts one hash sent to several recipients", async () => {
        const buyer = identity()
        const sellers = [identity(), identity(), identity()]
        const b = await register(buyer)
        const online = await Promise.all(sellers.map(s => register(s)))

        for (const s of sellers) {
            const reply = await sendAndWait(b.client, s, "rfq-envelope-sig")
            expect(reply.type).toBe("message_sent")
            expect(reply.payload.duplicate).toBeUndefined()
        }
        expect(submitToL2PS).toHaveBeenCalledTimes(3)
        for (const o of online) {
            expect((await o.client.next("message")).payload.messageHash).toBe("rfq-envelope-sig")
        }

        for (const c of [b.client, ...online.map(o => o.client)]) c.close()
    })

    it("answers a resend with the original outcome and does not deliver twice", async () => {
        const buyer = identity()
        const seller = identity()
        const b = await register(buyer)
        const s = await register(seller)

        await sendAndWait(b.client, seller, "h-resend")
        await s.client.next("message")

        const again = await sendAndWait(b.client, seller, "h-resend")
        expect(again.type).toBe("message_sent")
        expect(again.payload.duplicate).toBe(true)
        expect(submitToL2PS).toHaveBeenCalledTimes(1)
        await Bun.sleep(100)
        expect(s.client.has("message")).toBe(false)

        b.client.close()
        s.client.close()
    })

    it("answers a resend to an offline recipient as queued", async () => {
        const buyer = identity()
        const b = await register(buyer)
        const offline = identity()

        expect((await sendAndWait(b.client, offline, "h-offline")).type).toBe("message_queued")
        const again = await sendAndWait(b.client, offline, "h-offline")
        expect(again.type).toBe("message_queued")
        expect(again.payload.duplicate).toBe(true)
        expect([...rows.values()]).toHaveLength(1)
        b.client.close()
    })

    it("lets a failed send be retried under the same hash", async () => {
        const buyer = identity()
        const seller = identity()
        const b = await register(buyer)
        const s = await register(seller)

        submitResult = { success: false, error: "mempool unavailable" }
        const err = await sendAndWait(b.client, seller, "h-retry")
        expect(err.type).toBe("error")
        expect(err.payload.code).toBe("L2PS_SUBMIT_FAILED")

        submitResult = { success: true, txHash: "0xtx2" }
        const retried = await sendAndWait(b.client, seller, "h-retry")
        expect(retried.type).toBe("message_sent")
        expect(retried.payload.duplicate).toBeUndefined()
        expect((await s.client.next("message")).payload.messageHash).toBe("h-retry")
        expect([...rows.values()].map(r => r.status)).toEqual(["delivered"])

        b.client.close()
        s.client.close()
    })

    it("queues instead of recording delivery when the recipient's socket drops the frame", async () => {
        const buyer = identity()
        const seller = identity()
        const b = await register(buyer)
        const s = await register(seller)

        const srv = server as any
        const realSend = srv.send.bind(srv)
        srv.send = (ws: any, frame: any) => (frame.type === "message" ? false : realSend(ws, frame))
        try {
            const reply = await sendAndWait(b.client, seller, "h-dropped")
            expect(reply.type).toBe("message_queued")
            expect([...rows.values()].find(r => r.messageHash === "h-dropped")?.status).toBe("queued")
        } finally {
            srv.send = realSend
        }

        b.client.close()
        s.client.close()
    })

    it("resubmits a failed message once when two retries race", async () => {
        submitResult = { success: false, error: "mempool unavailable" }
        const first = await service.processMessage("aa", "bb", "subnet_a", crypto.randomUUID(), "h-race", encrypted, true)
        expect(first.success).toBe(false)
        submitToL2PS.mockClear()

        submitResult = { success: true, txHash: "0xtx3" }
        const results = await Promise.all([1, 2].map(() =>
            service.processMessage("aa", "bb", "subnet_a", crypto.randomUUID(), "h-race", encrypted, true)))

        expect(submitToL2PS).toHaveBeenCalledTimes(1)
        expect(results.filter((r: any) => r.success && !r.duplicate)).toHaveLength(1)
        expect(results.filter((r: any) => r.duplicate)).toHaveLength(1)
        expect([...rows.values()]).toHaveLength(1)
    })

    it("a resend during an in-flight attempt gets that attempt's outcome", async () => {
        let settle!: (r: { success: boolean; txHash?: string; error?: string }) => void
        submitToL2PS.mockImplementationOnce(() => new Promise(resolve => { settle = resolve }))

        const first = service.processMessage("aa", "bb", "subnet_a", crypto.randomUUID(), "h-inflight", encrypted, true)
        await Bun.sleep(20)
        const second = service.processMessage("aa", "bb", "subnet_a", crypto.randomUUID(), "h-inflight", encrypted, true)
        await Bun.sleep(20)
        settle({ success: false, error: "mempool unavailable" })

        const [r1, r2] = await Promise.all([first, second])
        expect(r1.success).toBe(false)
        expect(r2.success).toBe(false)
        expect(r2.duplicate).toBeUndefined()
        expect(submitToL2PS).toHaveBeenCalledTimes(1)

        submitResult = { success: true, txHash: "0xtx4" }
        const retry = await service.processMessage("aa", "bb", "subnet_a", crypto.randomUUID(), "h-inflight", encrypted, true)
        expect(retry.success).toBe(true)
        expect(retry.duplicate).toBeUndefined()
        expect(retry.l2psTxHash).toBe("0xtx4")
    })

    it("a resend during a succeeding attempt is answered as its duplicate", async () => {
        let settle!: (r: { success: boolean; txHash?: string }) => void
        submitToL2PS.mockImplementationOnce(() => new Promise(resolve => { settle = resolve }))

        const first = service.processMessage("aa", "cc", "subnet_a", crypto.randomUUID(), "h-inflight-ok", encrypted, true)
        await Bun.sleep(20)
        const second = service.processMessage("aa", "cc", "subnet_a", crypto.randomUUID(), "h-inflight-ok", encrypted, true)
        await Bun.sleep(20)
        settle({ success: true, txHash: "0xtx5" })

        const [r1, r2] = await Promise.all([first, second])
        expect(r1).toMatchObject({ success: true, l2psTxHash: "0xtx5" })
        expect(r2).toMatchObject({ success: true, duplicate: true, l2psTxHash: "0xtx5" })
        expect(submitToL2PS).toHaveBeenCalledTimes(1)
    })

    it("a resend during a succeeding attempt to an offline recipient is answered as queued", async () => {
        let settle!: (r: { success: boolean; txHash?: string }) => void
        submitToL2PS.mockImplementationOnce(() => new Promise(resolve => { settle = resolve }))

        const first = service.processMessage("aa", "cc", "subnet_a", crypto.randomUUID(), "h-inflight-offline", encrypted, false)
        await Bun.sleep(20)
        const second = service.processMessage("aa", "cc", "subnet_a", crypto.randomUUID(), "h-inflight-offline", encrypted, false)
        await Bun.sleep(20)
        settle({ success: true, txHash: "0xtx6" })

        const [r1, r2] = await Promise.all([first, second])
        expect(r1).toMatchObject({ success: true, status: "queued", l2psTxHash: "0xtx6" })
        expect(r2).toMatchObject({ success: true, duplicate: true, status: "queued", l2psTxHash: "0xtx6" })
        expect(submitToL2PS).toHaveBeenCalledTimes(1)
    })

    it("does not let another sender's message with the same hash block this one", async () => {
        const seller = identity()
        const s = await register(seller)
        const one = await register(identity())
        const two = await register(identity())

        for (const sender of [one, two]) {
            const reply = await sendAndWait(sender.client, seller, "same-text")
            expect(reply.type).toBe("message_sent")
            expect(reply.payload.duplicate).toBeUndefined()
        }

        for (const c of [s.client, one.client, two.client]) c.close()
    })
})
