import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test"
import { MessagingPeer } from "@kynesyslabs/demosdk/instant-messaging"
import type { signedObject } from "@kynesyslabs/demosdk/encryption"
import { serializeUint8Array } from "@kynesyslabs/demosdk/utils"
import { readFileSync } from "node:fs"
import { unifiedCrypto as ucrypto } from "../../../../node_modules/@kynesyslabs/demosdk/build/encryption/unifiedCrypto.js"
import { ImErrorType } from "./types/Errors"
import { clientIdFromSigningKey, registrationProofBytes } from "./types/IMMessage"
for (const name of ["@/libs/blockchain/transaction", "@/libs/blockchain/chain", "@/libs/blockchain/mempool"]) {
    mock.module(name, () => ({ default: {} }))
}
mock.module("@/libs/crypto/hashing", () => ({ default: { sha256: () => "test-hash" } }))
type QueuedRow = { id: string, recipientPublicKey: string, senderPublicKey: string, encryptedContent: string, timestamp: number, status: "pending" | "sent" }
const queuedRows: QueuedRow[] = []
let offlineFindCalls = 0
let offlineSaveCalls = 0
const sharedState: any = { identity: { ed25519: {} } }
const offlineRepository = {
    create: (values: any) => ({ ...values, id: `row-${queuedRows.length + 1}` }),
    save: async (row: QueuedRow) => { offlineSaveCalls++; queuedRows.push(row); return row },
    find: async ({ where }: { where: { recipientPublicKey: string, status: string } }) => {
        offlineFindCalls++
        return queuedRows.filter(row => row.recipientPublicKey === where.recipientPublicKey && row.status === where.status)
    },
    update: async (id: string, values: { status: "sent" }) => {
        const row = queuedRows.find(row => row.id === id)
        if (row) row.status = values.status
    },
}
mock.module("@/model/datasource", () => ({ default: {
    getInstance: async () => ({ getDataSource: () => ({ getRepository: () => offlineRepository }) }),
} }))
mock.module("@/utilities/sharedState", () => ({ getSharedState: sharedState }))
mock.module("@/model/entities/OfflineMessages", () => ({ OfflineMessage: {} }))
mock.module("@/utilities/logger", () => ({ default: { debug() {}, info() {}, error() {} } }))
mock.module("@/errors", () => ({ handleError() {} }))
mock.module("@/forks", () => ({ serializeTransactionContent() {}, txSignaturePreimageForPendingBlock() {} }))
let verifyProof = (proof: signedObject) => ucrypto.verify(proof)
mock.module("@/libs/blockchain/validation/txValidatorPool", () => ({ default: { getInstance: () => ({ verify: (proof: signedObject) => verifyProof(proof) }) } }))
const { SignalingServer } = await import("./signalingServer")
const signerA = ucrypto.getInstance("im-register-test-a")
const signerB = ucrypto.getInstance("im-register-test-b")
const signerEd = ucrypto.getInstance("im-register-test-ed")
const signerEdRecipient = ucrypto.getInstance("im-register-test-ed-recipient")
const keyA = new Uint8Array([1, 2, 3, 4])
const keyB = new Uint8Array([5, 6, 7, 8])
let idA: string, edId: string, edRecipientId: string
beforeAll(async () => {
    await signerA.generateIdentity("ml-dsa")
    await signerB.generateIdentity("ml-dsa")
    await signerEd.generateIdentity("ed25519")
    await signerEdRecipient.generateIdentity("ed25519")
    idA = clientIdFromSigningKey((await signerA.getIdentity("ml-dsa")).publicKey as Uint8Array)
    edId = clientIdFromSigningKey((await signerEd.getIdentity("ed25519")).publicKey as Uint8Array)
    edRecipientId = clientIdFromSigningKey((await signerEdRecipient.getIdentity("ed25519")).publicKey as Uint8Array)
})
beforeEach(() => { verifyProof = proof => ucrypto.verify(proof); queuedRows.length = 0; offlineFindCalls = 0; offlineSaveCalls = 0; sharedState.identity.ed25519.privateKey = undefined })
async function proof(key: Uint8Array, signer = signerA, id?: string, challenge = "challenge", algorithm: "ml-dsa" | "ed25519" = "ml-dsa") {
    const signed = await signer.sign(algorithm, id === undefined ? key : registrationProofBytes(id, key, challenge))
    return {
        algorithm: signed.algorithm,
        serializedPublicKey: serializeUint8Array(signed.publicKey as Uint8Array),
        serializedSignedData: serializeUint8Array(signed.signature as Uint8Array),
        serializedMessage: serializeUint8Array(signed.message),
    }
}
function harness(mode: "transitional" | "strict" = "transitional") {
    const server = Object.create(SignalingServer.prototype) as any
    server.peers = new Map()
    server.registrationChallenges = new WeakMap()
    server.registerMode = mode
    server.responseHandlers = new Set()
    server.deliverOfflineMessages = mock(async () => {})
    server.offlineMessageCounts = new Map()
    server.countMutex = { runExclusive: async (fn: () => Promise<void>) => fn() }
    server.MAX_OFFLINE_MESSAGES_PER_SENDER = 100
    return server
}
function socket(server: any, challenge = "challenge") {
    const messages: any[] = []
    const ws = { readyState: WebSocket.OPEN, send: (text: string) => messages.push(JSON.parse(text)) } as unknown as WebSocket
    server.registrationChallenges.set(ws, challenge)
    return { ws, messages }
}
async function attempt(server: any, id: string, key: any, signed: any, challenge?: string) {
    const result = socket(server, challenge)
    await server.handleRegister(result.ws, id, key, signed)
    return result
}
describe("signaling registration", () => {
    it("refuses to queue offline messages in transitional mode", async () => {
        sharedState.identity.ed25519.privateKey = Buffer.alloc(32, 1)
        const server = harness()
        const sender = await attempt(server, "sender-app", keyA, await proof(keyA))
        expect(sender.messages[0]?.payload.success).toBe(true)
        let chainWrites = 0
        server.storeMessageOnBlockchain = mock(async () => { chainWrites++ })
        const originalStore = server.storeOfflineMessage.bind(server)
        const store = mock(originalStore)
        server.storeOfflineMessage = store
        const message = "ciphertext" as any

        for (const targetId of ["legacy-client", "0XAB", "0xAB", edRecipientId]) {
            await server.handlePeerMessage(sender.ws, { targetId, message })
            expect(sender.messages.at(-1)).toMatchObject({
                type: "error",
                payload: { errorType: ImErrorType.PEER_NOT_FOUND, details: "Recipient is offline and cannot receive queued messages" },
            })
            expect(store).toHaveBeenCalledTimes(0)
            expect(offlineSaveCalls).toBe(0)
            expect(chainWrites).toBe(0)
            expect(server.offlineMessageCounts.size).toBe(0)
        }

        delete server.deliverOfflineMessages
        const recipient = await attempt(server, edRecipientId, keyB, await proof(keyB, signerB))
        expect(recipient.messages.map(frame => frame.type)).toEqual(["register"])
        expect(queuedRows).toHaveLength(0)
        expect(server.offlineMessageCounts.has("sender-app")).toBe(false)
    })
    it("queues key-form offline messages in strict mode and delivers them on registration", async () => {
        sharedState.identity.ed25519.privateKey = Buffer.alloc(32, 1)
        const server = harness("strict")
        const sender = await attempt(server, edId, keyA, await proof(keyA, signerEd, edId, "challenge", "ed25519"))
        expect(sender.messages[0]?.payload.success).toBe(true)
        let chainWrites = 0
        server.storeMessageOnBlockchain = mock(async () => { chainWrites++ })
        const originalStore = server.storeOfflineMessage.bind(server)
        const store = mock(originalStore)
        server.storeOfflineMessage = store
        const message = "ciphertext" as any
        for (const targetId of ["legacy-client", "0XAB", "0xAB"]) {
            await server.handlePeerMessage(sender.ws, { targetId, message })
            expect(sender.messages.at(-1)).toMatchObject({
                type: "error",
                payload: { errorType: ImErrorType.PEER_NOT_FOUND, details: "Recipient is offline and cannot receive queued messages" },
            })
            expect(store).toHaveBeenCalledTimes(0)
            expect(offlineSaveCalls).toBe(0)
            expect(chainWrites).toBe(0)
            expect(server.offlineMessageCounts.size).toBe(0)
        }

        delete server.deliverOfflineMessages
        await server.handlePeerMessage(sender.ws, { targetId: edRecipientId, message })
        expect(sender.messages.at(-1)?.type).toBe("message_queued")
        expect(store).toHaveBeenCalledTimes(1)
        expect(offlineSaveCalls).toBe(1)
        expect(queuedRows).toHaveLength(1)
        expect(queuedRows[0].status).toBe("pending")
        expect(chainWrites).toBe(1)
        expect(server.offlineMessageCounts.get(edId)).toBe(1)

        const recipient = await attempt(server, edRecipientId, keyB, await proof(keyB, signerEdRecipient, edRecipientId, "challenge", "ed25519"))
        expect(recipient.messages.map(frame => frame.type)).toEqual(["register", "message"])
        expect(recipient.messages[1].payload.message).toBe(message)
        expect(queuedRows[0].status).toBe("sent")
        expect(server.offlineMessageCounts.has(edId)).toBe(false)
    })
    it("queues offline messages only for full-length key IDs in strict mode", async () => {
        sharedState.identity.ed25519.privateKey = Buffer.alloc(32, 1)
        const server = harness("strict")
        const sender = await attempt(server, edId, keyA, await proof(keyA, signerEd, edId, "challenge", "ed25519"))
        expect(sender.messages[0]?.payload.success).toBe(true)
        const store = mock(server.storeOfflineMessage.bind(server))
        server.storeOfflineMessage = store
        const chainWrite = mock(async () => {})
        server.storeMessageOnBlockchain = chainWrite
        const message = "ciphertext" as any

        for (const targetId of ["0x1", edRecipientId.slice(0, -1), `${edRecipientId}0`]) {
            await server.handlePeerMessage(sender.ws, { targetId, message })
            expect(sender.messages.at(-1)).toMatchObject({
                type: "error",
                payload: { errorType: ImErrorType.PEER_NOT_FOUND, details: "Recipient is offline and cannot receive queued messages" },
            })
            expect(store).toHaveBeenCalledTimes(0)
            expect(queuedRows).toHaveLength(0)
            expect(chainWrite).toHaveBeenCalledTimes(0)
            expect(server.offlineMessageCounts.size).toBe(0)
        }

        expect(edRecipientId).toHaveLength(66)
        await server.handlePeerMessage(sender.ws, { targetId: edRecipientId, message })
        expect(sender.messages.at(-1)?.type).toBe("message_queued")
        expect(store).toHaveBeenCalledTimes(1)
        expect(queuedRows).toHaveLength(1)
        expect(chainWrite).toHaveBeenCalledTimes(1)
        expect(server.offlineMessageCounts.get(edId)).toBe(1)
    })
    it("delivers messages to online recipients in transitional mode", async () => {
        const server = harness()
        const sender = await attempt(server, "sender-app", keyA, await proof(keyA))
        let chainWrites = 0
        server.storeMessageOnBlockchain = mock(async () => { chainWrites++ })
        const message = "ciphertext" as any

        const online = await attempt(server, "online-client", keyB, await proof(keyB, signerB))
        expect(online.messages[0]?.payload.success).toBe(true)
        await server.handlePeerMessage(sender.ws, { targetId: "online-client", message })
        expect(online.messages.at(-1)).toEqual({ type: "message", payload: { message, fromId: "sender-app" } })
        expect(offlineSaveCalls).toBe(0)
        expect(chainWrites).toBe(1)
        expect(server.offlineMessageCounts.size).toBe(0)
    })
    it("keeps queued rows pending for a legacy free-form ID", async () => {
        const server = harness()
        delete server.deliverOfflineMessages
        queuedRows.push({ id: "row-1", recipientPublicKey: "legacy-client", senderPublicKey: "sender", encryptedContent: "ciphertext", timestamp: 1, status: "pending" })
        const result = await attempt(server, "legacy-client", keyA, await proof(keyA))
        expect(result.messages.map(message => message.type)).toEqual(["register"])
        expect(result.messages[0]?.payload.success).toBe(true)
        expect(queuedRows[0].status).toBe("pending")
    })
    it("keeps queued rows pending when delivery is called for a legacy free-form ID", async () => {
        const server = harness()
        delete server.deliverOfflineMessages
        queuedRows.push({ id: "row-1", recipientPublicKey: "legacy-client", senderPublicKey: "sender", encryptedContent: "ciphertext", timestamp: 1, status: "pending" })
        const { ws, messages } = await attempt(server, "legacy-client", keyA, await proof(keyA))
        await server.deliverOfflineMessages(ws, "legacy-client")
        expect(messages.map(message => message.type)).toEqual(["register"])
        expect(queuedRows[0].status).toBe("pending")
        expect(offlineFindCalls).toBe(0)
    })
    it("delivers queued rows when delivery is called for a key-bound ID", async () => {
        const server = harness()
        queuedRows.push({ id: "row-1", recipientPublicKey: idA, senderPublicKey: "sender", encryptedContent: "ciphertext", timestamp: 1, status: "pending" })
        const { ws, messages } = await attempt(server, idA, keyA, await proof(keyA, signerA, idA))
        delete server.deliverOfflineMessages
        await server.deliverOfflineMessages(ws, idA)
        expect(messages.map(message => message.type)).toEqual(["register", "message"])
        expect(messages[1]?.payload.message).toBe("ciphertext")
        expect(queuedRows[0].status).toBe("sent")
        expect(offlineFindCalls).toBe(1)
    })
    it("keeps queued rows pending when delivery is called with a different socket", async () => {
        const server = harness()
        await attempt(server, idA, keyA, await proof(keyA))
        delete server.deliverOfflineMessages
        queuedRows.push({ id: "row-1", recipientPublicKey: idA, senderPublicKey: "sender", encryptedContent: "ciphertext", timestamp: 1, status: "pending" })
        const other = socket(server)
        await server.deliverOfflineMessages(other.ws, idA)
        expect(other.messages).toEqual([])
        expect(queuedRows[0].status).toBe("pending")
        expect(offlineFindCalls).toBe(0)
    })
    it("keeps queued rows pending for a key-derived ID registered with a legacy signature", async () => {
        const server = harness()
        delete server.deliverOfflineMessages
        const advertisedKey = new TextEncoder().encode("arbitrary-message")
        queuedRows.push({ id: "row-1", recipientPublicKey: edId, senderPublicKey: "sender", encryptedContent: "ciphertext", timestamp: 1, status: "pending" })
        const { ws, messages } = socket(server)
        server.registrationChallenges.set(ws, undefined)
        await server.handleRegister(ws, edId, advertisedKey, await proof(advertisedKey, signerEd, undefined, "challenge", "ed25519"))
        expect(messages.map(message => message.type)).toEqual(["register"])
        expect(messages[0]?.payload.success).toBe(true)
        expect(queuedRows[0].status).toBe("pending")
        expect(offlineFindCalls).toBe(0)
    })
    it("does not read queued rows when delivery is called without a registered peer", async () => {
        const server = harness()
        delete server.deliverOfflineMessages
        queuedRows.push({ id: "row-1", recipientPublicKey: idA, senderPublicKey: "sender", encryptedContent: "ciphertext", timestamp: 1, status: "pending" })
        const { ws, messages } = socket(server)
        await server.deliverOfflineMessages(ws, idA)
        expect(messages).toEqual([])
        expect(queuedRows[0].status).toBe("pending")
        expect(offlineFindCalls).toBe(0)
    })
    it.each(["transitional", "strict"] as const)("delivers queued rows once for a key-bound registration in %s mode", async mode => {
        const server = harness(mode)
        delete server.deliverOfflineMessages
        const id = mode === "strict" ? edId : idA
        const signed = mode === "strict" ? await proof(keyA, signerEd, id, "challenge", "ed25519") : await proof(keyA, signerA, id)
        queuedRows.push({ id: "row-1", recipientPublicKey: id, senderPublicKey: "sender", encryptedContent: "ciphertext", timestamp: 1, status: "pending" })
        const first = await attempt(server, id, keyA, signed)
        expect(first.messages.map(message => message.type)).toEqual(["register", "message"])
        expect(first.messages[1]?.payload.message).toBe("ciphertext")
        expect(queuedRows[0].status).toBe("sent")
        server.handleClose(first.ws)
        const second = await attempt(server, id, keyA, signed)
        expect(second.messages.map(message => message.type)).toEqual(["register"])
    })
    it.each(["transitional", "strict"] as const)("accepts a bound proof in %s mode", async mode => {
        const server = harness(mode)
        const id = mode === "strict" ? edId : idA
        const result = await attempt(server, id, keyA, await proof(keyA, mode === "strict" ? signerEd : signerA, id, "challenge", mode === "strict" ? "ed25519" : "ml-dsa"))
        expect(result.messages[0]?.payload.success).toBe(true)
        expect(server.peers.get(id)?.ws).toBe(result.ws)
        server.handleClose(result.ws)
    })
    it("refuses an ML-DSA v1 proof in strict mode before verification", async () => {
        let calls = 0
        verifyProof = async signed => { calls++; return ucrypto.verify(signed) }
        const result = await attempt(harness("strict"), idA, keyA, await proof(keyA, signerA, idA))
        expect(result.messages[0]?.payload.errorType).toBe(ImErrorType.INVALID_PROOF)
        expect(calls).toBe(0)
    })
    it("refuses an ed25519 proof with a wrong signing key length before verification", async () => {
        let calls = 0
        verifyProof = async signed => { calls++; return ucrypto.verify(signed) }
        const signed = await proof(keyA, signerEd, edId, "challenge", "ed25519")
        signed.serializedPublicKey = serializeUint8Array(new Uint8Array(31))
        const result = await attempt(harness("strict"), edId, keyA, signed)
        expect(result.messages[0]?.payload.errorType).toBe(ImErrorType.INVALID_PROOF)
        expect(calls).toBe(0)
    })
    it("documents the requested challenge and includes registration tests in CI", () => {
        const changelog = readFileSync(new URL("../../../../CHANGELOG.md", import.meta.url), "utf8")
        expect(changelog).toContain('Clients request a `register_challenge` by sending `{type:"register_challenge",payload:{}}`')
        expect(changelog).toContain("registration requires an ed25519-signed proof")
        expect(changelog).toContain("A connection may register one client ID.")
        expect(changelog).toContain("clients using the legacy registration proof do not receive them.")
        const ci = readFileSync(new URL("../../../../scripts/test-consensus.sh", import.meta.url), "utf8")
        expect(ci).toContain("src/config/loader.signalingRegisterMode.test.ts")
        expect(ci).toContain("src/features/InstantMessagingProtocol/signalingServer/signalingServer.test.ts")
    })
    it.each(["transitional", "strict"] as const)("handles a legacy proof in %s mode", async mode => {
        const result = await attempt(harness(mode), "legacy-client", keyA, await proof(keyA))
        expect(result.messages[0]?.payload.success).toBe(mode === "transitional" ? true : undefined)
        if (mode === "strict") expect(result.messages[0]?.payload.errorType).toBe(ImErrorType.INVALID_PROOF)
    })
    it("releases a legacy free-form ID after disconnect", async () => {
        const server = harness()
        const first = await attempt(server, "legacy-client", keyA, await proof(keyA))
        expect(first.messages[0]?.payload.success).toBe(true)
        server.handleClose(first.ws)
        const second = await attempt(server, "legacy-client", keyB, await proof(keyB, signerB))
        expect(second.messages[0]?.payload.success).toBe(true)
    })
    it.each(["transitional", "strict"] as const)("rejects another signing key for a key-derived ID in %s mode", async mode => {
        const result = await attempt(harness(mode), idA, keyB, await proof(keyB, signerB, mode === "strict" ? idA : undefined))
        expect(result.messages[0]?.payload.errorType).toBe(ImErrorType.INVALID_PROOF)
    })
    it("preserves a legacy client ID's spelling", async () => {
        const server = harness()
        const upperId = edId.toUpperCase().replace("0X", "0x")
        const result = await attempt(server, upperId, keyA, await proof(keyA, signerEd, undefined, "challenge", "ed25519"))
        expect(result.messages[0]?.payload.success).toBe(true)
        expect(server.peers.get(upperId)?.ws).toBe(result.ws)
        server.handleClose(result.ws)
    })
    it("rejects a legacy claim for another key-derived ID", async () => {
        const upperId = "0x" + "AB".repeat(32)
        const result = await attempt(harness(), upperId, keyA, await proof(keyA, signerEd, undefined, "challenge", "ed25519"))
        expect(result.messages[0]?.payload.errorType).toBe(ImErrorType.INVALID_PROOF)
    })
    it.each(["transitional", "strict"] as const)("rejects another signing key for a second key-derived ID in %s mode", async mode => {
        const result = await attempt(harness(mode), clientIdFromSigningKey(new Uint8Array(32)), keyA, await proof(keyA, signerEd, mode === "strict" ? edId : undefined, "challenge", "ed25519"))
        expect(result.messages[0]?.payload.errorType).toBe(ImErrorType.INVALID_PROOF)
    })
    it.each(["transitional", "strict"] as const)("accepts a second key-derived ID in %s mode", async mode => {
        const result = await attempt(harness(mode), edId, keyA, await proof(keyA, signerEd, edId, "challenge", "ed25519"))
        expect(result.messages[0]?.payload.success).toBe(true)
    })
    it("registers nine concurrent legacy IDs and permits sequential sessions", async () => {
        const server = harness()
        const signed = await proof(keyA)
        for (let i = 0; i < 9; i++) expect((await attempt(server, `legacy-${i}`, keyA, signed)).messages[0]?.payload.success).toBe(true)
        for (const peer of [...server.peers.values()]) server.handleClose(peer.ws)
        expect((await attempt(server, "legacy-8", keyA, signed)).messages[0]?.payload.success).toBe(true)
    })
    it("rejects long IDs before verification", async () => {
        let calls = 0
        verifyProof = async signed => { calls++; return ucrypto.verify(signed) }
        const result = await attempt(harness(), "x".repeat(4096), keyA, await proof(keyA))
        expect(result.messages[0]?.payload.errorType).toBe(ImErrorType.INVALID_MESSAGE)
        expect(calls).toBe(0)
    })
    it("refuses an advertised key above the length limit", async () => {
        let calls = 0
        verifyProof = async signed => { calls++; return ucrypto.verify(signed) }
        const key = Array(4097).fill(0)
        Object.defineProperty(key, 0, { get() { throw new Error("key bytes were read") } })
        const result = await attempt(harness(), idA, key, await proof(keyA, signerA, idA))
        expect(result.messages[0]?.payload.errorType).toBe(ImErrorType.INVALID_PUBLIC_KEY)
        expect(calls).toBe(0)
    })
    it("requires a requested challenge in strict mode", async () => {
        const result = await attempt(harness("strict"), edId, keyA, await proof(keyA, signerEd, edId, "challenge", "ed25519"), "")
        expect(result.messages[0]?.payload.errorType).toBe(ImErrorType.INVALID_PROOF)
        expect(result.messages[0]?.payload.details).toBe("Registration challenge required")
    })
    it("issues a challenge on request and accepts its proof in strict mode", async () => {
        const server = harness("strict")
        const { ws, messages } = socket(server, "")
        await server.handleMessage(ws, JSON.stringify({ type: "register_challenge", payload: {} }))
        const challenge = messages[0]?.payload.challenge
        expect(challenge).toMatch(/^[0-9a-f]{64}$/)
        await server.handleRegister(ws, edId, keyA, await proof(keyA, signerEd, edId, challenge, "ed25519"))
        expect(messages[1]?.payload.success).toBe(true)
    })
    it("replaces a previously issued challenge", async () => {
        const server = harness("strict")
        const { ws, messages } = socket(server, "")
        const request = JSON.stringify({ type: "register_challenge", payload: {} })
        await server.handleMessage(ws, request)
        const first = messages[0].payload.challenge
        await server.handleMessage(ws, request)
        expect(messages[1].payload.challenge).not.toBe(first)
        await server.handleRegister(ws, edId, keyA, await proof(keyA, signerEd, edId, first, "ed25519"))
        expect(messages[2]?.payload.errorType).toBe(ImErrorType.INVALID_PROOF)
    })
    it("keeps registration scoped to one ID per connection", async () => {
        const server = harness("strict")
        const { ws, messages } = socket(server, "")
        const request = JSON.stringify({ type: "register_challenge", payload: {} })
        await server.handleMessage(ws, request)
        await server.handleRegister(ws, edId, keyA, await proof(keyA, signerEd, edId, messages[0].payload.challenge, "ed25519"))
        expect(messages[1]?.payload.success).toBe(true)
        await server.handleMessage(ws, request)
        expect(messages[2]?.payload.errorType).toBe(ImErrorType.INVALID_MESSAGE)
        await server.handleRegister(ws, "another-id", keyA, await proof(keyA))
        expect(messages[3]?.payload.errorType).toBe(ImErrorType.INVALID_MESSAGE)
        expect(server.peers.size).toBe(1)
    })
    it("rejects a proof made for another challenge", async () => {
        const signed = await proof(keyA, signerEd, edId, "challenge", "ed25519")
        const result = await attempt(harness("strict"), edId, keyA, signed, "other-challenge")
        expect(result.messages[0]?.payload.errorType).toBe(ImErrorType.INVALID_PROOF)
    })
    it.each([[], [1, , 3, 4], [257], [1.5], [-1]])("rejects malformed advertised key %j", async key => {
        const result = await attempt(harness(), idA, key, await proof(keyA, signerA, idA))
        expect(result.messages[0]?.payload.errorType).toBe(ImErrorType.INVALID_PUBLIC_KEY)
    })
    it("rejects a substituted advertised key", async () => {
        const result = await attempt(harness(), idA, keyB, await proof(keyA, signerA, idA))
        expect(result.messages[0]?.payload.errorType).toBe(ImErrorType.INVALID_PROOF)
    })
    it("registers the load generator through a local WebSocket", async () => {
        const { registerClient } = await import("../../../../testing/loadgen/src/im_shared")
        const server = new SignalingServer(0) as any
        server.deliverOfflineMessages = mock(async () => {})
        try {
            const client = await registerClient({ wsUrl: `ws://127.0.0.1:${server.server.port}`, clientId: "loadgen-client", instanceId: "im-register-loadgen-test", timeoutSec: 1 })
            try {
                expect(client.clientId).toHaveLength(66)
                expect(clientIdFromSigningKey(server.peers.get(client.clientId)?.signingPublicKey)).toBe(client.clientId)
                expect(server).not.toHaveProperty("seenSigningKeys")
            } finally { client.close() }
        } finally { server.server.stop(true) }
    })
    it("sends no frame before the client requests a challenge", async () => {
        const server = new SignalingServer(0) as any
        const ws = new WebSocket(`ws://127.0.0.1:${server.server.port}`)
        const messages: string[] = []
        ws.onmessage = event => messages.push(String(event.data))
        try {
            await new Promise<void>(resolve => ws.addEventListener("open", () => resolve(), { once: true }))
            await Bun.sleep(50)
            expect(messages).toHaveLength(0)
            ws.send(JSON.stringify({ type: "register_challenge", payload: {} }))
            await new Promise<void>(resolve => ws.addEventListener("message", () => resolve(), { once: true }))
            expect(JSON.parse(messages[0]).type).toBe("register_challenge")
        } finally { ws.close(); server.server.stop(true) }
    })
    it("connects the installed SDK through a local WebSocket", async () => {
        await ucrypto.generateIdentity("ml-dsa")
        await ucrypto.generateIdentity("ml-kem-aes")
        const publicKey = (await ucrypto.getIdentity("ml-kem-aes")).publicKey as Uint8Array
        const server = new SignalingServer(0) as any
        server.registerMode = "transitional"
        server.deliverOfflineMessages = mock(async () => {})
        const peer = new MessagingPeer({ serverUrl: `ws://127.0.0.1:${server.server.port}`, clientId: "sdk-live-id", publicKey })
        try {
            await peer.connect()
            expect(server.peers.has("sdk-live-id")).toBe(true)
        } finally { peer.disconnect(); server.server.stop(true) }
    })
    it("interoperates with the installed SDK", async () => {
        await ucrypto.generateIdentity("ml-dsa")
        await ucrypto.generateIdentity("ml-kem-aes")
        const publicKey = (await ucrypto.getIdentity("ml-kem-aes")).publicKey as Uint8Array
        const server = harness()
        const { ws, messages } = socket(server)
        const peer = new MessagingPeer({ serverUrl: "ws://unused", clientId: "sdk-id", publicKey })
        ;(peer as any).sendToServerAndWait = async (message: any) => {
            const { clientId, publicKey, verification } = message.payload
            await server.handleRegister(ws, clientId, publicKey, verification)
        }
        await peer.registerAndWait()
        expect(messages[0]?.payload.success).toBe(true)
    })
    it("does not overwrite an ID claimed during verification", async () => {
        const server = harness()
        const first = socket(server)
        const second = socket(server)
        let release!: (value: boolean) => void
        const pending = new Promise<boolean>(resolve => { release = resolve })
        verifyProof = async signed => new TextDecoder().decode(signed.message).includes(",[1,2,3,4],") ? pending : ucrypto.verify(signed)
        const registration = server.handleRegister(first.ws, idA, keyA, await proof(keyA, signerA, idA))
        await server.handleRegister(second.ws, idA, keyB, await proof(keyB, signerA, idA))
        release(true)
        await registration
        expect(first.messages[0]?.payload.errorType).toBe(ImErrorType.CLIENT_ID_TAKEN)
        expect(server.peers.get(idA)?.ws).toBe(second.ws)
    })
    it("stops after rejecting an incomplete register frame", async () => {
        const server = harness()
        const { ws, messages } = socket(server)
        await server.handleMessage(ws, JSON.stringify({ type: "register", payload: { clientId: idA, publicKey: Array.from(keyA) } }))
        expect(messages).toHaveLength(1)
        expect(messages[0]?.payload.errorType).toBe(ImErrorType.INVALID_MESSAGE)
        expect(server.peers.size).toBe(0)
    })
})
