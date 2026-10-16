/**
 * A full subnet queue, seen from the messaging relay.
 *
 * The sender gets a retry-later answer, and nothing is stored for a message the
 * node did not take. Below the cap the message goes through as before.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest, mock } from "bun:test"
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto"

const rows = new Map<string, Record<string, any>>()
const repo = {
    findOneBy: async () => null,
    save: async (row: Record<string, any>) => {
        rows.set(row.id, { ...row })
        return row
    },
    update: async () => ({ affected: 1 }),
    find: async () => [],
}
const guard = { check: jest.fn(), claim: jest.fn(), release: jest.fn(), settle: jest.fn() }

mock.module("@/model/datasource", () => ({
    __esModule: true,
    dataSource: { getRepository: () => repo },
    default: { getInstance: async () => ({ getDataSource: () => ({ getRepository: () => repo }) }) },
}))
mock.module("@/libs/l2ps/parallelNetworks", () => ({
    __esModule: true,
    default: { getInstance: () => ({ getL2PS: async (uid: string) => (uid === "subnet_a" ? {} : null) }) },
}))
mock.module("@/libs/blockchain/transaction", () => ({ __esModule: true, default: class {} }))
mock.module("@/libs/blockchain/l2ps_mempool", () => ({ __esModule: true, default: {} }))
mock.module("@/libs/l2ps/L2PSTransactionExecutor", () => ({ __esModule: true, default: {} }))
mock.module("@/utilities/sharedState", () => ({ getSharedState: { signingAlgorithm: "ed25519" } }))
mock.module("@/libs/l2ps/executedBacklogGuard", () => ({
    __esModule: true,
    L2PS_BACKLOG_FULL: "L2PS_BACKLOG_FULL",
    getExecutedBacklogGuard: () => guard,
}))

const { L2PSMessagingService } = await import("../L2PSMessagingService")
const { L2PSMessagingServer } = await import("../L2PSMessagingServer")

const service = L2PSMessagingService.getInstance() as any
const submitToL2PS = jest.spyOn(service, "submitToL2PS").mockImplementation(async (...args: unknown[]) => {
    const onExecuted = args[7] as () => void
    onExecuted()
    return { success: true, txHash: "0xtx" }
})

interface Identity {
    publicKey: string
    privateKey: KeyObject
}

function identity(): Identity {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519")
    const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url")
    return { publicKey: raw.toString("hex"), privateKey }
}

let server: any
let port = 0

async function connect(id: Identity) {
    const ws = new WebSocket(`ws://localhost:${port}`)
    const inbox: any[] = []
    ws.addEventListener("message", e => inbox.push(JSON.parse(e.data as string)))
    await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve)
        ws.addEventListener("error", reject)
    })
    // Presence frames can arrive in between; the tests wait for an answer.
    const next = async (): Promise<any> => {
        for (let i = 0; i < 100; i++) {
            const at = inbox.findIndex(f => !["peer_joined", "peer_left"].includes(f.type))
            if (at >= 0) return inbox.splice(at, 1)[0]
            await Bun.sleep(20)
        }
        throw new Error("timeout")
    }
    const timestamp = Date.now()
    const proof = sign(null, Buffer.from(`register:${id.publicKey}:${timestamp}`), id.privateKey).toString("hex")
    ws.send(JSON.stringify({ type: "register", payload: { publicKey: id.publicKey, l2psUid: "subnet_a", proof }, timestamp }))
    await next()
    return { ws, next }
}

const encrypted = { ciphertext: Buffer.from("m").toString("base64"), nonce: Buffer.from("n").toString("base64") }

beforeAll(() => {
    server = new L2PSMessagingServer(0)
    port = server.server.port
})
afterAll(() => server.stop())
beforeEach(() => {
    rows.clear()
    guard.check.mockReset()
    guard.claim.mockReset()
    guard.claim.mockReturnValue(true)
    guard.release.mockReset()
    guard.settle.mockReset()
    service.offlineMessageCounts.clear()
    submitToL2PS.mockClear()
})

describe("messaging relay with a full subnet queue", () => {
    it("answers a retry-later error and stores nothing", async () => {
        guard.check.mockResolvedValue({ admitted: false, count: 50_000, cap: 50_000, retryAfterMs: 10_000 })
        const alice = identity()
        const bob = identity()
        const a = await connect(alice)
        await connect(bob)

        a.ws.send(JSON.stringify({
            type: "send",
            payload: { to: bob.publicKey, encrypted, messageHash: "h1" },
            timestamp: Date.now(),
            requestId: "r1",
        }))
        const reply = await a.next()

        expect(reply.type).toBe("error")
        expect(reply.payload.code).toBe("L2PS_BACKLOG_FULL")
        expect(reply.payload.retryAfterMs).toBe(10_000)
        expect(reply.requestId).toBe("r1")
        expect(rows.size).toBe(0)
        expect(submitToL2PS).not.toHaveBeenCalled()
        expect(guard.claim).not.toHaveBeenCalled()
        expect(guard.release).not.toHaveBeenCalled()
    })

    it("delivers as before while the queue has room", async () => {
        guard.check.mockResolvedValue({ admitted: true })
        const alice = identity()
        const bob = identity()
        const a = await connect(alice)
        await connect(bob)

        a.ws.send(JSON.stringify({ type: "send", payload: { to: bob.publicKey, encrypted, messageHash: "h2" }, timestamp: Date.now() }))
        const reply = await a.next()

        expect(reply.type).toBe("message_sent")
        expect(rows.size).toBe(1)
        expect(guard.claim).toHaveBeenCalledTimes(1)
        expect(guard.settle).toHaveBeenCalledTimes(1)
        expect(guard.release).not.toHaveBeenCalled()
    })

    it("gives the slot back when the row was stored but never executed", async () => {
        guard.check.mockResolvedValue({ admitted: true })
        submitToL2PS.mockResolvedValueOnce({ success: true, txHash: "0xtx" })

        const result = await service.processMessage("alice", "bob", "subnet_a", "m0", "h0", encrypted, true)

        expect(result.success).toBe(true)
        expect(guard.release).toHaveBeenCalledTimes(1)
        expect(guard.settle).not.toHaveBeenCalled()
    })

    it("answers retry-later when the subnet fills between the check and the claim, and keeps the sender's quota", async () => {
        guard.check.mockResolvedValue({ admitted: true })
        guard.claim.mockReturnValue(false)

        const result = await service.processMessage("alice", "bob", "subnet_a", "m1", "h3", encrypted, false)

        expect(result.code).toBe("L2PS_BACKLOG_FULL")
        expect(rows.size).toBe(0)
        expect(service.offlineMessageCounts.size).toBe(0)
        expect(guard.release).not.toHaveBeenCalled()
    })

    it("lets a sender at its offline quota take no subnet slot", async () => {
        guard.check.mockResolvedValue({ admitted: true })
        service.offlineMessageCounts.set("alice", 200)

        const result = await service.processMessage("alice", "bob", "subnet_a", "m2", "h4", encrypted, false)

        expect(result).toEqual({ success: false, error: "Offline message limit reached" })
        expect(guard.claim).not.toHaveBeenCalled()
        expect(guard.release).not.toHaveBeenCalled()
        expect(rows.size).toBe(0)
    })

    it("gives the slot back when the submission fails", async () => {
        guard.check.mockResolvedValue({ admitted: true })
        submitToL2PS.mockResolvedValueOnce({ success: false, error: "L2PS network not loaded" })

        const result = await service.processMessage("alice", "bob", "subnet_a", "m3", "h5", encrypted, true)

        expect(result.success).toBe(false)
        expect(guard.claim).toHaveBeenCalledTimes(1)
        expect(guard.release).toHaveBeenCalledTimes(1)
    })

    it("gives the slot back when the row cannot be written", async () => {
        guard.check.mockResolvedValue({ admitted: true })
        const save = jest.spyOn(repo, "save").mockRejectedValueOnce({ code: "23505" })

        const result = await service.processMessage("alice", "bob", "subnet_a", "m4", "h6", encrypted, true)
        save.mockRestore()

        expect(result.success).toBe(false)
        expect(submitToL2PS).not.toHaveBeenCalled()
        expect(guard.release).toHaveBeenCalledTimes(1)
    })
})
