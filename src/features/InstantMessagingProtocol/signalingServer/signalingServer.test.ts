/**
 * A message routed through the signalling server is kept as a transaction the
 * node signs and adds to its own mempool, addressed to the message's target
 * ID, and, while the target is offline, as an `offline_messages` row keyed by
 * it. The target ID is held to the bytes those columns index before either is
 * written.
 *
 * The server, its sockets and its routing are real. The chain, the database
 * and the signer are replaced, and the mempool by a recorder.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { Cryptography } from "@kynesyslabs/demosdk/encryption"
import { mockLogger } from "@/utilities/testSupport/coreMocks"

mockLogger("@/utilities/logger")

const added: Array<Record<string, any>> = []
const stored: Array<Record<string, any>> = []

mock.module("@/libs/blockchain/mempool", () => ({
    __esModule: true,
    default: {
        addTransaction: async (tx: Record<string, any>) => {
            added.push(tx)
            return { confirmationBlock: 101, error: "" }
        },
    },
}))
mock.module("@/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getLastBlockNumber: async () => 100 },
}))
mock.module("@/libs/blockchain/validation/txValidatorPool", () => ({
    __esModule: true,
    default: {
        getInstance: () => ({
            verify: async () => true,
            sign: async () => ({ signature: new Uint8Array(64) }),
        }),
    },
}))
mock.module("@/model/datasource", () => ({
    __esModule: true,
    default: {
        getInstance: async () => ({
            getDataSource: () => ({
                getRepository: () => ({
                    find: async () => [],
                    create: (row: Record<string, any>) => ({ ...row }),
                    save: async (row: Record<string, any>) => {
                        stored.push(row)
                        return Object.assign(row, { id: String(stored.length) })
                    },
                    delete: async () => ({ affected: 1 }),
                }),
            }),
        }),
    },
    dataSource: {},
}))

const { SignalingServer } = await import("./signalingServer")
const { getSharedState } = await import("@/utilities/sharedState")
const { INDEX_KEY_MAX_BYTES } = await import("@/libs/blockchain/validation/postgresStorable")

getSharedState.keypair = { publicKey: new Uint8Array(32).fill(0xab), privateKey: new Uint8Array(64) }
getSharedState.identity = { ed25519: Cryptography.new() } as never

const ACCOUNT = "0x" + "cd".repeat(32)
const LONG_ID = "x".repeat(1100)
const ENCRYPTED = { algorithm: "ml-kem-aes", serializedEncryptedData: "AA==", serializedCipherText: "AA==" }

let server: InstanceType<typeof SignalingServer>
let url: string
let sockets: WebSocket[] = []

beforeEach(() => {
    added.length = 0
    stored.length = 0
    server = new SignalingServer(0)
    url = `ws://127.0.0.1:${(server as any).server.port}`
})

afterEach(() => {
    for (const ws of sockets) ws.close()
    sockets = []
    server.disconnect()
})

/** A client socket; `next` is the next message it receives, or null after `ms`. */
async function connect() {
    const ws = new WebSocket(url)
    const inbox: any[] = []
    let wake: (() => void) | null = null
    ws.onmessage = event => {
        inbox.push(JSON.parse(String(event.data)))
        wake?.()
    }
    await new Promise(resolve => (ws.onopen = resolve))
    sockets.push(ws)
    return {
        send: (message: unknown) => ws.send(JSON.stringify(message)),
        next: async (ms = 1000): Promise<any> => {
            if (inbox.length === 0) {
                await new Promise<void>(resolve => {
                    const timer = setTimeout(resolve, ms)
                    wake = () => {
                        clearTimeout(timer)
                        resolve()
                    }
                })
                wake = null
            }
            return inbox.shift() ?? null
        },
    }
}

async function registered(clientId: string) {
    const client = await connect()
    // A proof without a challenge must sign the advertised key bytes ([1, 2, 3]).
    const proof = { algorithm: "ed25519", serializedSignedData: "AA==", serializedPublicKey: "AA==", serializedMessage: "AQID" }
    client.send({ type: "register", payload: { clientId, publicKey: [1, 2, 3], verification: proof } })
    expect(await client.next()).toMatchObject({ type: "register", payload: { success: true } })
    return client
}

/**
 * Registration refuses an ID this long, so a peer holding one is put in place
 * directly: the message path must not rely on registration for the bound.
 */
function online(clientId: string): unknown[] {
    const received: unknown[] = []
    ;(server as any).peers.set(clientId, {
        id: clientId,
        ws: { readyState: WebSocket.OPEN, send: (frame: string) => received.push(frame) },
        publicKey: new Uint8Array([1, 2, 3]),
        signingPublicKey: new Uint8Array(32),
        deliverQueued: false,
    })
    return received
}

const send = (targetId: unknown) => ({ type: "message", payload: { targetId, message: ENCRYPTED } })
const invalid = { type: "error", payload: { errorType: "INVALID_MESSAGE" } }

describe("SignalingServer message target", () => {
    it("refuses a target ID longer than its columns index while the target is offline", async () => {
        const sender = await registered("alice")
        sender.send(send(LONG_ID))
        const reply = await sender.next()
        expect(added.map(tx => tx.content.to.length)).toEqual([])
        expect(stored.map(row => row.recipientPublicKey.length)).toEqual([])
        expect(reply).toMatchObject(invalid)
    })

    it("refuses it while the target is online", async () => {
        const sender = await registered("alice")
        const target = online(LONG_ID)
        sender.send(send(LONG_ID))
        const reply = await sender.next()
        expect(added.map(tx => tx.content.to.length)).toEqual([])
        expect(reply).toMatchObject(invalid)
        expect(target).toEqual([])
    })

    it("cannot be registered by a key it does not name", async () => {
        const client = await connect()
        const proof = { algorithm: "ed25519", serializedSignedData: "AA==", serializedPublicKey: "AA==", serializedMessage: "AQID" }
        client.send({ type: "register", payload: { clientId: LONG_ID, publicKey: [1, 2, 3], verification: proof } })
        expect(await client.next()).toMatchObject(invalid)
    })

    it("measures it in UTF-8 bytes", async () => {
        const sender = await registered("alice")
        sender.send(send("é".repeat(INDEX_KEY_MAX_BYTES / 2 + 1)))
        expect(await sender.next()).toMatchObject(invalid)
        expect(added).toEqual([])
    })

    for (const targetId of ["bob\u0000", "bob\ud800"]) {
        it(`refuses an unstorable target ID before writing (${JSON.stringify(targetId)})`, async () => {
            const sender = await registered("alice")
            sender.send(send(targetId))
            expect(await sender.next()).toMatchObject(invalid)
            expect(added).toEqual([])
            expect(stored).toEqual([])
        })
    }

    for (const targetId of [42, ["bob"], { id: "bob" }]) {
        it(`refuses a target ID that is not a string (${JSON.stringify(targetId)})`, async () => {
            const sender = await registered("alice")
            sender.send(send(targetId))
            expect(await sender.next()).toMatchObject(invalid)
            expect(added).toEqual([])
            expect(stored).toEqual([])
        })
    }

    it("refuses a message to an offline account in the default register mode, and writes nothing", async () => {
        const sender = await registered("alice")
        sender.send(send(ACCOUNT))
        expect(await sender.next()).toMatchObject({ type: "error", payload: { errorType: "PEER_NOT_FOUND" } })
        expect(added).toEqual([])
        expect(stored).toEqual([])
    })

    it("queues a message to an offline account in strict register mode as before", async () => {
        const sender = await registered("alice")
        ;(server as any).registerMode = "strict"
        sender.send(send(ACCOUNT))
        expect(await sender.next()).toMatchObject({ type: "message_queued", payload: { targetId: ACCOUNT, status: "offline" } })
        expect(added.map(tx => tx.content.to)).toEqual([ACCOUNT])
        expect(stored.map(row => row.recipientPublicKey)).toEqual([ACCOUNT])
    })

    it("forwards a message to an online account as before", async () => {
        const sender = await registered("alice")
        const target = await registered(ACCOUNT)
        sender.send(send(ACCOUNT))
        expect(await target.next()).toMatchObject({ type: "message", payload: { fromId: "alice", message: ENCRYPTED } })
        expect(added.map(tx => tx.content.to)).toEqual([ACCOUNT])
    })

    it("lets a target ID of exactly the bytes its columns index past the bound", async () => {
        const sender = await registered("alice")
        const targetId = "x".repeat(INDEX_KEY_MAX_BYTES)
        const target = online(targetId)
        sender.send(send(targetId))
        await sender.next(300)
        expect(target).toHaveLength(1)
        expect(added.map(tx => tx.content.to)).toEqual([targetId])
    })
})

describe("SignalingServer public key request", () => {
    it("refuses a target ID longer than its columns index", async () => {
        const client = await registered("alice")
        online(LONG_ID)
        client.send({ type: "request_public_key", payload: { targetId: LONG_ID } })
        expect(await client.next()).toMatchObject(invalid)
    })

    it("answers for an account as before", async () => {
        const client = await registered("alice")
        await registered(ACCOUNT)
        client.send({ type: "request_public_key", payload: { targetId: ACCOUNT } })
        expect(await client.next()).toMatchObject({ type: "public_key_response", payload: { peerId: ACCOUNT, publicKey: [1, 2, 3] } })
    })
})
