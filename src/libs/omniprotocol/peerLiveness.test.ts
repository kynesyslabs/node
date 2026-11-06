/**
 * The quiet-peer probe and the peerlist's last-seen times must work for a
 * peer that talks only over Omni. The probe's "ping" gets the same answer as
 * on HTTP, and verified Omni traffic in either direction refreshes the
 * peer's last-seen time, so a live Omni peer is never marked offline.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"
import forge from "node-forge"

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

const sharedState: Record<string, any> = {
    publicKeyHex: "0xself",
    keypair: { publicKey: new Uint8Array(32) },
    signingAlgorithm: "ed25519",
    genesisBlockHash: "d5".repeat(32),
    isOmniProtocolEnabled: true,
    omniAdapter: null,
    omniConfig: { port: 0, rateLimit: { enabled: false } },
    getConsensusTime: () => 1,
    getConnectionString: async () => "",
    version: "test",
    getInfo: async () => ({}),
}
jest.mock("src/utilities/sharedState", () => ({ getSharedState: sharedState }))

// Mirrors the real fallback for a method no nodeCall handler knows.
const nodeCalls: any[] = []
jest.mock("src/libs/network/manageNodeCall", () => ({
    manageNodeCall: async (content: any) => {
        nodeCalls.push(content)
        return {
            result: 404,
            response: { error: "Unknown message", message: content.message },
            require_reply: false,
            extra: null,
        }
    },
}))

const { default: PeerManager } = await import("src/libs/peer/PeerManager")
const { default: Peer } = await import("src/libs/peer/Peer")
const { PeerOmniAdapter } = await import("./integration/peerAdapter")
const { dispatchOmniMessage } = await import("./protocol/dispatcher")
const { handleNodeCall } = await import("./protocol/handlers/control")
const { MessageFramer } = await import("./transport/MessageFramer")
const { encodeNodeCallRequest, decodeNodeCallResponse } = await import(
    "./serialization/control"
)
const { SignatureAlgorithm, SignatureMode } = await import("./auth/types")
const { timestampedSignedData } = await import("./auth/signedData")
const { OmniOpcode } = await import("./protocol/opcodes")
const { DEFAULT_OMNIPROTOCOL_CONFIG } = await import("./types/config")

type Keys = { publicKey: Buffer; privateKey: Buffer }

const newKeys = (): Keys => {
    const pair = forge.pki.ed25519.generateKeyPair()
    return {
        publicKey: Buffer.from(pair.publicKey),
        privateKey: Buffer.from(pair.privateKey),
    }
}
const idOf = (keys: Keys) => "0x" + keys.publicKey.toString("hex")

let sequence = 1

/** Builds a parsed message signed the way PeerConnection.sendAuthenticated does. */
function message(payload: Buffer, sign?: { claims: Keys; signer: Keys }) {
    const seq = sequence++
    const header = {
        version: 1,
        opcode: OmniOpcode.NODE_CALL,
        sequence: seq,
        payloadLength: payload.length,
    }
    let bytes: Buffer
    if (!sign) {
        bytes = MessageFramer.encodeMessage(header, payload)
    } else {
        const timestamp = Date.now()
        const data = timestampedSignedData(sharedState.genesisBlockHash, sharedState.publicKeyHex, header.opcode, seq, timestamp, payload)
        const signature = forge.pki.ed25519.sign({
            message: data,
            privateKey: sign.signer.privateKey as forge.pki.ed25519.NativeBuffer,
        })
        bytes = MessageFramer.encodeMessage(header, payload, {
            algorithm: SignatureAlgorithm.ED25519,
            signatureMode: SignatureMode.SIGN_TIMESTAMPED_PAYLOAD_HASH,
            timestamp,
            identity: sign.claims.publicKey,
            signature: Buffer.from(signature),
        })
    }
    const framer = new MessageFramer()
    framer.addData(bytes)
    return framer.extractMessage()!
}

const context = () => ({
    peerIdentity: "",
    connectionId: "conn",
    remoteAddress: "10.0.0.9",
    isAuthenticated: false,
})

const dispatch = (msg: any) =>
    dispatchOmniMessage({
        message: msg,
        context: context() as any,
        fallbackToHttp: async () => {
            throw new Error("no http")
        },
    })

const pingPayload = () => encodeNodeCallRequest({ method: "ping", params: [] })

const peerman = PeerManager.getInstance()
const table = () => (peerman as any).peerList as Record<string, any>
const STALE = 1_000

/** Puts a peer in the online table with a last-seen time far outside the window. */
function stalePeer(identity: string) {
    const peer = new Peer("http://10.0.0.9:53550", identity)
    peer.status.online = true
    peer.status.timestamp = STALE
    table()[identity] = peer
    return peer
}

beforeEach(() => {
    nodeCalls.length = 0
    for (const key of Object.keys(table())) delete table()[key]
})

describe("Omni ping", () => {
    it("answers ping like the HTTP route instead of falling to an unknown nodeCall", async () => {
        const response = decodeNodeCallResponse(
            await handleNodeCall({
                message: message(pingPayload()),
                context: context(),
                fallbackToHttp: async () => Buffer.alloc(0),
            } as any),
        )

        expect(response.status).toBe(200)
        expect(response.value).toBe("pong")
        expect(nodeCalls).toHaveLength(0)
    })

    it("lets Peer.connect() succeed through the Omni adapter", async () => {
        const prober = newKeys()
        const adapter = new PeerOmniAdapter({ config: DEFAULT_OMNIPROTOCOL_CONFIG })
        adapter.migrationMode = "OMNI_ONLY"
        ;(adapter as any).getPrivateKey = () => prober.privateKey
        ;(adapter as any).getPublicKey = () => prober.publicKey
        // Loops the request back through the real dispatcher and handlers.
        ;(adapter as any).connectionPool = {
            sendAuthenticated: async (
                _identity: string,
                _url: string,
                _opcode: number,
                payload: Buffer,
            ) => dispatch(message(payload, { claims: prober, signer: prober })),
            send: async () => {
                throw new Error("unauthenticated send not expected")
            },
        }
        sharedState.omniAdapter = adapter
        const httpCall = jest.fn(async () => ({
            result: 500,
            response: "http used",
            require_reply: false,
            extra: null,
        }))

        const target = stalePeer(idOf(newKeys()))
        target.httpCall = httpCall as any

        expect(await target.connect()).toBe(true)
        expect(httpCall).not.toHaveBeenCalled()
        expect(target.status.timestamp).toBeGreaterThan(STALE)
        sharedState.omniAdapter = null
    })

    it("keeps failing the probe against a peer that answers ping with 404, as an older node does", async () => {
        const ours = newKeys()
        const adapter = new PeerOmniAdapter({ config: DEFAULT_OMNIPROTOCOL_CONFIG })
        adapter.migrationMode = "OMNI_ONLY"
        ;(adapter as any).getPrivateKey = () => ours.privateKey
        ;(adapter as any).getPublicKey = () => ours.publicKey
        ;(adapter as any).connectionPool = {
            sendAuthenticated: async () =>
                (await import("./serialization/control")).encodeNodeCallResponse({
                    status: 404,
                    value: "Unknown message",
                    requireReply: false,
                    extra: null,
                }),
        }
        sharedState.omniAdapter = adapter

        const target = stalePeer(idOf(newKeys()))
        target.httpCall = jest.fn() as any

        expect(await target.connect()).toBe(false)
        sharedState.omniAdapter = null
    })
})

describe("Omni traffic refreshes last-seen", () => {
    it("refreshes the sender of a verified incoming message", async () => {
        const sender = newKeys()
        const peer = stalePeer(idOf(sender))

        await dispatch(message(pingPayload(), { claims: sender, signer: sender }))

        expect(peer.status.timestamp).toBeGreaterThan(STALE)
        expect(peerman.isPeerFresh(peer)).toBe(true)
    })

    it("leaves the claimed peer stale when the message is unsigned or forged", async () => {
        const victim = newKeys()
        const peer = stalePeer(idOf(victim))

        await dispatch(message(pingPayload()))
        await expect(
            dispatch(message(pingPayload(), { claims: victim, signer: newKeys() })),
        ).rejects.toThrow()

        expect(peer.status.timestamp).toBe(STALE)
        expect(peerman.isPeerFresh(peer)).toBe(false)
    })

    it("refreshes the peer that answered an outgoing call", async () => {
        const ours = newKeys()
        const adapter = new PeerOmniAdapter({ config: DEFAULT_OMNIPROTOCOL_CONFIG })
        adapter.migrationMode = "OMNI_ONLY"
        ;(adapter as any).getPrivateKey = () => ours.privateKey
        ;(adapter as any).getPublicKey = () => ours.publicKey
        ;(adapter as any).connectionPool = {
            sendAuthenticated: async () =>
                (await import("./serialization/control")).encodeNodeCallResponse({
                    status: 200,
                    value: 7,
                    requireReply: false,
                    extra: null,
                }),
        }

        const peer = stalePeer(idOf(newKeys()))
        const response = await adapter.adaptCall(peer, {
            method: "nodeCall",
            params: [{ message: "getLastBlockNumber", data: {}, muid: "" }],
        })

        expect(response.result).toBe(200)
        expect(peer.status.timestamp).toBeGreaterThan(STALE)
        expect(peerman.isPeerFresh(peer)).toBe(true)
    })
})
