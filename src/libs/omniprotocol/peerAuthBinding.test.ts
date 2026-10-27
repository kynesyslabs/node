/**
 * A connection is bound to an identity only by a verified auth block, and
 * every message that acts on a sender is verified on its own. A forged block
 * must not leave an identity behind for later auth-less messages to inherit.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"
import { EventEmitter } from "events"
import forge from "node-forge"
import { keccak_256 } from "@noble/hashes/sha3.js"

jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        only: jest.fn(),
        custom: jest.fn(),
    },
}))
jest.mock("src/utilities/sharedState", () => ({
    getSharedState: {
        getConnectionString: async () => "",
        version: "test",
        getInfo: async () => ({}),
    },
}))

const consensusCalls: { sender: string; payload: any }[] = []
jest.mock("src/libs/network/manageConsensusRoutines", () => ({
    __esModule: true,
    default: async (sender: string, payload: any) => {
        consensusCalls.push({ sender, payload })
        return { result: 200, response: "ok", require_reply: false, extra: null }
    },
}))
const senderCalls: { kind: string; sender: string; arg: any }[] = []
jest.mock("src/libs/network/endpointHandlers", () => ({
    __esModule: true,
    default: {
        handleMempool: async (arg: any, sender: string) => {
            senderCalls.push({ kind: "mempool", sender, arg })
            return { result: 200, response: "ok", requireReply: false, extra: null }
        },
    },
}))
jest.mock("src/libs/network/manageHelloPeer", () => ({
    manageHelloPeer: async (arg: any, sender: string) => {
        senderCalls.push({ kind: "hello_peer", sender, arg })
        return { result: 200, response: "ok", require_reply: false, extra: null }
    },
}))
jest.mock("src/libs/network/manageGCRRoutines", () => ({
    __esModule: true,
    default: async (sender: string, arg: any) => {
        senderCalls.push({ kind: "gcr_routine", sender, arg })
        return { result: 200, response: "ok", require_reply: false, extra: null }
    },
}))
const nodeCalls: any[] = []
jest.mock("src/libs/network/manageNodeCall", () => ({
    manageNodeCall: async (content: any) => {
        nodeCalls.push(content)
        return { result: 200, response: 1, require_reply: false, extra: null }
    },
}))

const { PeerConnection } = await import("./transport/PeerConnection")
const { InboundConnection } = await import("./server/InboundConnection")
const { MessageFramer } = await import("./transport/MessageFramer")
const { encodeNodeCallRequest, decodeNodeCallResponse } = await import(
    "./serialization/control"
)
const { encodeProposeBlockHashRequest } = await import(
    "./serialization/consensus"
)
const { SignatureAlgorithm, SignatureMode } = await import("./auth/types")
const { OmniOpcode } = await import("./protocol/opcodes")

type Keys = { publicKey: Buffer; privateKey: Buffer }

const newKeys = (): Keys => {
    const pair = forge.pki.ed25519.generateKeyPair()
    return {
        publicKey: Buffer.from(pair.publicKey),
        privateKey: Buffer.from(pair.privateKey),
    }
}
const idOf = (keys: Keys) => "0x" + keys.publicKey.toString("hex")

let sequence = 100

/** Signs the way PeerConnection.sendAuthenticated does. */
function frame(
    opcode: number,
    payload: Buffer,
    sign?: { claims: Keys; signer: Keys },
): Buffer {
    const seq = sequence++
    const header = { version: 1, opcode, sequence: seq, payloadLength: payload.length }
    if (!sign) return MessageFramer.encodeMessage(header, payload)

    const msgId = Buffer.allocUnsafe(4)
    msgId.writeUInt32BE(seq)
    const data = Buffer.concat([msgId, Buffer.from(keccak_256(payload))])
    const signature = forge.pki.ed25519.sign({
        message: data,
        privateKey: sign.signer.privateKey as forge.pki.ed25519.NativeBuffer,
    })
    return MessageFramer.encodeMessage(header, payload, {
        algorithm: SignatureAlgorithm.ED25519,
        signatureMode: SignatureMode.SIGN_MESSAGE_ID_PAYLOAD_HASH,
        timestamp: Date.now(),
        identity: sign.claims.publicKey,
        signature: Buffer.from(signature),
    })
}

class FakeSocket extends EventEmitter {
    remoteAddress = "10.0.0.9"
    remotePort = 40000
    writable = true
    written: Buffer[] = []
    ended = false
    setNoDelay() {}
    setKeepAlive() {}
    write(buf: Buffer, cb?: (e?: Error) => void) {
        this.written.push(buf)
        cb?.()
        return true
    }
    end() {
        this.ended = true
        setImmediate(() => this.emit("close"))
    }
    destroy() {
        this.emit("close")
    }
}

/** Feeds bytes in and returns the decoded nodeCall status of the next response. */
async function exchange(socket: FakeSocket, bytes: Buffer): Promise<number> {
    const before = socket.written.length
    socket.emit("data", bytes)
    for (let i = 0; i < 100 && socket.written.length === before; i++) {
        await new Promise(r => setTimeout(r, 5))
    }
    const framer = new MessageFramer()
    framer.addData(socket.written[before])
    const message = framer.extractMessage()!
    return decodeNodeCallResponse(message.payload as Buffer).status
}

const greenlight = (blockRef = 7) =>
    encodeNodeCallRequest({
        method: "consensus_routine",
        params: [{ method: "greenlight", params: [blockRef, Date.now(), 1] }],
    })

beforeEach(() => {
    consensusCalls.length = 0
    senderCalls.length = 0
    nodeCalls.length = 0
})

const connections: { name: string; make: (s: FakeSocket) => any; identity: (c: any) => string | null; pending: (c: any) => boolean }[] = [
    {
        name: "PeerConnection",
        make: socket => new PeerConnection("pending:test", "", socket as any),
        identity: c => (c.peerIdentity.startsWith("pending:") ? null : c.peerIdentity),
        pending: c => c.getState() === 3,
    },
    {
        name: "InboundConnection",
        make: socket => {
            const c = new InboundConnection(socket as any, "conn-1", {
                authTimeout: 60_000,
                connectionTimeout: 60_000,
            })
            c.start()
            return c
        },
        identity: c => c.getPeerIdentity(),
        pending: c => c.getState() === "PENDING_AUTH",
    },
]

for (const kind of connections) {
    describe(`${kind.name} identity binding`, () => {
        it("keeps a forged auth block from naming X, and X is not adopted", async () => {
            const victim = newKeys()
            const attacker = newKeys()
            const socket = new FakeSocket()
            const conn = kind.make(socket)
            const authenticated = jest.fn()
            conn.on("authenticated", authenticated)

            // Claims to be the victim, signed with another key.
            await exchange(
                socket,
                frame(OmniOpcode.NODE_CALL, greenlight(), {
                    claims: victim,
                    signer: attacker,
                }),
            ).catch(() => undefined)

            expect(authenticated).not.toHaveBeenCalled()
            expect(kind.identity(conn)).not.toBe(idOf(victim))
            expect(socket.ended).toBe(true)

            // The follow-up without auth must not arrive as the victim.
            const status = await exchange(socket, frame(OmniOpcode.NODE_CALL, greenlight()))
            expect(status).toBe(401)
            expect(consensusCalls).toHaveLength(0)
            expect(kind.identity(conn)).not.toBe(idOf(victim))
        })

        it("adopts the identity once the signature verifies", async () => {
            const peer = newKeys()
            const socket = new FakeSocket()
            const conn = kind.make(socket)
            const authenticated = jest.fn()
            conn.on("authenticated", authenticated)

            const status = await exchange(
                socket,
                frame(OmniOpcode.NODE_CALL, greenlight(), { claims: peer, signer: peer }),
            )

            expect(status).toBe(200)
            expect(authenticated).toHaveBeenCalledWith(idOf(peer))
            expect(consensusCalls).toEqual([
                { sender: idOf(peer), payload: expect.anything() },
            ])
        })

        it("still verifies each sender-bound message on its own after authentication", async () => {
            const peer = newKeys()
            const socket = new FakeSocket()
            const conn = kind.make(socket)
            await exchange(
                socket,
                frame(OmniOpcode.NODE_CALL, greenlight(), { claims: peer, signer: peer }),
            )
            consensusCalls.length = 0

            const status = await exchange(socket, frame(OmniOpcode.NODE_CALL, greenlight()))

            expect(status).toBe(401)
            expect(consensusCalls).toHaveLength(0)
            expect(kind.pending(conn)).toBe(false)
        })

        it("answers an auth-required opcode sent without a block with an error, and keeps the connection", async () => {
            const socket = new FakeSocket()
            const conn = kind.make(socket)

            const before = socket.written.length
            socket.emit(
                "data",
                frame(
                    OmniOpcode.PROPOSE_BLOCK_HASH,
                    encodeProposeBlockHashRequest({
                        blockHash: "ab".repeat(32),
                        validationData: {},
                        proposer: "",
                    }),
                ),
            )
            for (let i = 0; i < 100 && socket.written.length === before; i++) {
                await new Promise(r => setTimeout(r, 5))
            }

            expect(socket.written).toHaveLength(before + 1)
            expect(socket.written[before].toString("utf8")).toContain("Authentication required")
            expect(socket.ended).toBe(false)
            expect(kind.pending(conn)).toBe(true)
            expect(consensusCalls).toHaveLength(0)
        })

        const gated: [string, string, unknown[]][] = [
            ["mempool", "mempool", [{ txs: [] }]],
            ["hello_peer", "hello_peer", [{ url: "http://x" }]],
            ["gcr_routine", "gcr_routine", [{ method: "syncNewBlock", params: [] }]],
            ["gcr_routine", "gcr_routine", [{ method: "updateSyncData", params: ["1:1:h"] }]],
            ["gcr_routine", "gcr_routine", [{ method: "identity_assign_from_write", params: [{}] }]],
            ["gcr_routine", "gcr_routine", [{ method: "getNomisIdentities", params: [] }]],
            ["gcr_routine", "gcr_routine", [{ method: "somethingNew", params: [] }]],
        ]
        for (const [name, kindName, params] of gated) {
            const label = name === "gcr_routine" ? `${name}.${(params[0] as any).method}` : name
            it(`requires a verified block on each ${label} message`, async () => {
                const peer = newKeys()
                const socket = new FakeSocket()
                kind.make(socket)
                const call = encodeNodeCallRequest({ method: name, params })

                expect(await exchange(socket, frame(OmniOpcode.NODE_CALL, call))).toBe(401)
                expect(senderCalls).toHaveLength(0)

                expect(
                    await exchange(
                        socket,
                        frame(OmniOpcode.NODE_CALL, call, { claims: peer, signer: peer }),
                    ),
                ).toBe(200)
                expect(senderCalls).toEqual([
                    { kind: kindName, sender: idOf(peer), arg: expect.anything() },
                ])

                senderCalls.length = 0
                expect(await exchange(socket, frame(OmniOpcode.NODE_CALL, call))).toBe(401)
                expect(senderCalls).toHaveLength(0)
            })
        }

        it("leaves a gcr_routine read open without auth", async () => {
            const socket = new FakeSocket()
            kind.make(socket)

            const status = await exchange(
                socket,
                frame(
                    OmniOpcode.NODE_CALL,
                    encodeNodeCallRequest({
                        method: "gcr_routine",
                        params: [{ method: "getPoints", params: ["0xabc"] }],
                    }),
                ),
            )

            expect(status).toBe(200)
            expect(senderCalls).toHaveLength(1)
            expect(senderCalls[0].sender).toBe("")
        })

        it("leaves read-only nodeCall queries open without auth", async () => {
            const socket = new FakeSocket()
            kind.make(socket)

            const status = await exchange(
                socket,
                frame(
                    OmniOpcode.NODE_CALL,
                    encodeNodeCallRequest({
                        method: "nodeCall",
                        params: [{ message: "getLastBlockNumber", data: {}, muid: "" }],
                    }),
                ),
            )

            expect(status).toBe(200)
            expect(nodeCalls).toHaveLength(1)
        })

        it("hands the verified sender, not the body's proposer, to proposeBlockHash", async () => {
            const sender = newKeys()
            const named = newKeys()
            const socket = new FakeSocket()
            kind.make(socket)

            socket.emit(
                "data",
                frame(
                    OmniOpcode.PROPOSE_BLOCK_HASH,
                    encodeProposeBlockHashRequest({
                        blockHash: "ab".repeat(32),
                        validationData: {},
                        proposer: idOf(named),
                    }),
                    { claims: sender, signer: sender },
                ),
            )
            for (let i = 0; i < 100 && consensusCalls.length === 0; i++) {
                await new Promise(r => setTimeout(r, 5))
            }

            expect(consensusCalls).toHaveLength(1)
            expect(consensusCalls[0].payload.params[2]).toBe(idOf(sender))
        })
    })
}

describe("dispatcher identity", () => {
    it("blanks the connection's identity for a message without a verified block", async () => {
        const { dispatchOmniMessage } = await import("./protocol/dispatcher")
        const { handlerRegistry } = await import("./protocol/registry")
        const descriptor = handlerRegistry.get(OmniOpcode.GET_PEER_INFO)!
        const original = descriptor.handler
        const seen: any[] = []
        descriptor.handler = async ({ context }) => {
            seen.push({ ...context })
            return Buffer.alloc(0)
        }

        try {
            await dispatchOmniMessage({
                message: {
                    header: { version: 1, opcode: OmniOpcode.GET_PEER_INFO, sequence: 1, payloadLength: 0 },
                    payload: Buffer.alloc(0),
                    auth: null,
                    checksum: 0,
                } as any,
                context: { peerIdentity: "0xvictim", isAuthenticated: true },
                fallbackToHttp: async () => Buffer.alloc(0),
            })
        } finally {
            descriptor.handler = original
        }

        expect(seen).toHaveLength(1)
        expect(seen[0].peerIdentity).toBe("")
        expect(seen[0].isAuthenticated).toBe(false)
    })
})
