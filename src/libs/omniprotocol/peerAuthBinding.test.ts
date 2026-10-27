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
    setNoDelay() {}
    setKeepAlive() {}
    write(buf: Buffer, cb?: (e?: Error) => void) {
        this.written.push(buf)
        cb?.()
        return true
    }
    end() {
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
