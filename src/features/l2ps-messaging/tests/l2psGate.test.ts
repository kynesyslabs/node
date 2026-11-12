/**
 * The messaging relay under an `l2psGate` scheduled above the height the
 * server started at: once the tip reaches the gate, every frame is refused,
 * so a connected peer can no longer queue L2PS traffic the pool would refuse.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest, mock } from "bun:test"
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto"

const rows = new Map<string, Record<string, any>>()
const repo = {
    count: async () => 0,
    findOneBy: async () => null,
    save: async (row: Record<string, any>) => {
        rows.set(row.id, { ...row })
        return row
    },
    update: async () => ({ affected: 1 }),
    find: async () => [],
}
const guard = { check: jest.fn(), claim: jest.fn(), release: jest.fn(), settle: jest.fn() }
const GATE_HEIGHT = 50
const sharedState: Record<string, any> = {
    signingAlgorithm: "ed25519",
    forkConfig: { l2psGate: { activationHeight: GATE_HEIGHT } },
    lastBlockNumber: 10,
}

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
mock.module("@/utilities/sharedState", () => ({ getSharedState: sharedState }))
mock.module("@/libs/l2ps/executedBacklogGuard", () => ({
    __esModule: true,
    L2PS_BACKLOG_FULL: "L2PS_BACKLOG_FULL",
    getExecutedBacklogGuard: () => guard,
}))

const { L2PSMessagingService } = await import("../L2PSMessagingService")
const { L2PSMessagingServer } = await import("../L2PSMessagingServer")
const { L2PS_GATE_REFUSAL } = await import("@/forks/l2psGate")

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

async function open() {
    const ws = new WebSocket(`ws://localhost:${port}`)
    const inbox: any[] = []
    ws.addEventListener("message", e => inbox.push(JSON.parse(e.data as string)))
    await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve)
        ws.addEventListener("error", reject)
    })
    const next = async (): Promise<any> => {
        for (let i = 0; i < 100; i++) {
            const at = inbox.findIndex(f => !["peer_joined", "peer_left"].includes(f.type))
            if (at >= 0) return inbox.splice(at, 1)[0]
            await Bun.sleep(20)
        }
        throw new Error("timeout")
    }
    return { ws, next }
}

function registerFrame(id: Identity) {
    const timestamp = Date.now()
    const proof = sign(null, Buffer.from(`register:${id.publicKey}:${timestamp}`), id.privateKey).toString("hex")
    return JSON.stringify({ type: "register", payload: { publicKey: id.publicKey, l2psUid: "subnet_a", proof }, timestamp, requestId: "reg" })
}

const encrypted = { ciphertext: Buffer.from("m").toString("base64"), nonce: Buffer.from("n").toString("base64") }
const sendFrame = (to: string, hash: string) =>
    JSON.stringify({ type: "send", payload: { to, encrypted, messageHash: hash }, timestamp: Date.now(), requestId: hash })

beforeAll(() => {
    server = new L2PSMessagingServer(0)
    port = server.server.port
})
afterAll(() => server.stop())
beforeEach(() => {
    rows.clear()
    sharedState.lastBlockNumber = 10
    guard.check.mockReset()
    guard.check.mockResolvedValue({ admitted: true })
    guard.claim.mockReset()
    guard.claim.mockReturnValue(true)
    submitToL2PS.mockClear()
})

describe("messaging relay when l2psGate activates after startup", () => {
    it("relays below the gate height and refuses a registered peer's send once the tip reaches it", async () => {
        const alice = identity()
        const bob = identity()
        const a = await open()
        const b = await open()
        a.ws.send(registerFrame(alice))
        expect((await a.next()).type).toBe("registered")
        b.ws.send(registerFrame(bob))
        expect((await b.next()).type).toBe("registered")

        a.ws.send(sendFrame(bob.publicKey, "before"))
        expect((await a.next()).type).toBe("message_sent")
        expect(submitToL2PS).toHaveBeenCalledTimes(1)

        sharedState.lastBlockNumber = GATE_HEIGHT
        a.ws.send(sendFrame(bob.publicKey, "after"))
        const refused = await a.next()

        expect(refused.type).toBe("error")
        expect(refused.payload).toMatchObject({ code: "L2PS_DISABLED", message: L2PS_GATE_REFUSAL })
        expect(refused.requestId).toBe("after")
        expect(submitToL2PS).toHaveBeenCalledTimes(1)
        expect(rows.size).toBe(1)
    })

    it("refuses a new registration once the gate is active", async () => {
        sharedState.lastBlockNumber = GATE_HEIGHT + 1
        const c = await open()
        c.ws.send(registerFrame(identity()))
        const refused = await c.next()

        expect(refused.type).toBe("error")
        expect(refused.payload.code).toBe("L2PS_DISABLED")
        expect(refused.requestId).toBe("reg")
    })
})
