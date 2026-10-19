/**
 * The real messaging server and service with the database and the L2PS
 * pipeline faked, shared by the relay tests.
 *
 * Importing this module registers the module mocks, so it has to be imported
 * before anything that loads the service.
 */
import { jest } from "bun:test"
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto"

// ─── In-memory l2ps_messages ─────────────────────────────────────

export type Row = Record<string, any>
export const rows = new Map<string, Row>()
export const faults: {
    save: Error | null
    update: ((patch: Row) => Error | null) | null
    /** The write commits and the error still reaches the caller, as when the connection drops before the reply. */
    lostReply: boolean
} = { save: null, update: null, lostReply: false }
const tupleOf = (r: Row) => JSON.stringify([r.l2psUid, r.fromKey, r.toKey, r.messageHash])

const repo = {
    findOneBy: async (where: Row) =>
        [...rows.values()].find(r => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null,
    save: async (row: Row) => {
        if (faults.save && !faults.lostReply) throw faults.save
        for (const r of rows.values()) {
            if (r.id !== row.id && tupleOf(r) === tupleOf(row)) {
                throw Object.assign(new Error("duplicate key"), { code: "23505" })
            }
        }
        rows.set(row.id, { ...row })
        if (faults.save) throw faults.save
        return row
    },
    update: async (criteria: string | string[] | Row, patch: Row) => {
        const fault = faults.update?.(patch)
        if (fault && !faults.lostReply) throw fault
        const matches = typeof criteria === "string" || Array.isArray(criteria)
            ? [criteria].flat().map(id => rows.get(id)).filter(Boolean) as Row[]
            : [...rows.values()].filter(r => Object.entries(criteria).every(([k, v]) => r[k] === v))
        for (const r of matches) Object.assign(r, patch)
        if (fault) throw fault
        return { affected: matches.length }
    },
    delete: async (id: string) => {
        rows.delete(id)
    },
    find: async (query?: { where?: unknown; take?: number }) => {
        if (Array.isArray(query?.where)) {
            return (query.where as Row[]).map(w => rows.get(w.id)).filter(Boolean).map(r => ({ ...r }))
        }
        if (query?.where && typeof query.where === "object") {
            const where = query.where as Row
            return [...rows.values()]
                .filter(r => Object.entries(where).every(([k, v]) => r[k] === v))
                .sort((a, b) => Number(a.timestamp) - Number(b.timestamp))
                .slice(0, typeof query?.take === "number" ? query.take : undefined)
                .map(r => ({ ...r }))
        }
        return []
    },
    count: async (query?: { where?: Row }) =>
        [...rows.values()].filter(r => Object.entries(query?.where ?? {}).every(([k, v]) => r[k] === v)).length,
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
            getMany: async () => historyRows.map(r => ({ ...r })),
        }
        return qb
    },
}
/** What the history query builder answers with; tests fill it. */
export const historyRows: Row[] = []
export const queryTake: unknown[] = []
export const conditions: unknown[] = []

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

export const service = L2PSMessagingService.getInstance() as any
const OK = { success: true, txHash: "0xtx" }
/** What the stubbed L2PS submission answers; tests set `relay.submitResult` to steer it. */
export const relay: { submitResult: { success: boolean; txHash?: string; error?: string }; port: number; server: any } = {
    submitResult: OK,
    port: 0,
    server: null,
}
// The service is a process-wide singleton shared with other test files.
export const submitToL2PS = jest.spyOn(service, "submitToL2PS").mockImplementation(async () => relay.submitResult)

// ─── Keys and sockets ────────────────────────────────────────────

export interface Identity {
    publicKey: string
    privateKey: KeyObject
}

export function identity(): Identity {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519")
    const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url")
    return { publicKey: raw.toString("hex"), privateKey }
}

export function proofFor(id: Identity, timestamp: number, l2psUid?: string): string {
    const message = l2psUid ? `register:${l2psUid}:${id.publicKey}:${timestamp}` : `register:${id.publicKey}:${timestamp}`
    return sign(null, Buffer.from(message), id.privateKey).toString("hex")
}

/** Port 0 lets the system pick a free one, so a busy port cannot fail the run. */
export function startRelayServer(): void {
    const server = new L2PSMessagingServer(0)
    relay.server = server
    relay.port = (server as unknown as { server: { port: number } }).server.port
}

export function stopRelayServer(): void {
    relay.server.stop()
    submitToL2PS.mockRestore()
}

/** Back to an empty store, no injected faults and a submission that succeeds. */
export function resetRelay(): void {
    // Every test registers from the same loopback address.
    relay.server?.registerByAddress.clear()
    rows.clear()
    queryTake.length = 0
    historyRows.length = 0
    conditions.length = 0
    faults.save = null
    faults.update = null
    faults.lostReply = false
    relay.submitResult = OK
    submitToL2PS.mockReset()
    submitToL2PS.mockImplementation(async () => relay.submitResult)
}

export class Client {
    private inbox: any[] = []
    private waiters: Array<() => void> = []
    constructor(readonly ws: WebSocket) {
        ws.addEventListener("message", e => {
            this.inbox.push(JSON.parse(e.data as string))
            this.waiters.splice(0).forEach(w => w())
        })
    }

    static async open(): Promise<Client> {
        const ws = new WebSocket(`ws://localhost:${relay.port}`)
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

export async function register(id: Identity, l2psUid = "subnet_a", timestamp = Date.now(), proof?: string) {
    const client = await Client.open()
    client.frame("register", { publicKey: id.publicKey, l2psUid, proof: proof ?? proofFor(id, timestamp) }, timestamp)
    return { client, reply: await client.next("registered") }
}

export const encrypted = { ciphertext: Buffer.from("quote").toString("base64"), nonce: Buffer.from("n").toString("base64") }

export async function sendAndWait(from: Client, to: Identity, messageHash: string) {
    from.frame("send", { to: to.publicKey, encrypted, messageHash })
    return from.next(["message_sent", "message_queued"])
}
