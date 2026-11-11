/**
 * A peer's HTTP auth headers sign the request body, so a captured request
 * cannot be replayed with another body. The signature also names the
 * network (genesis hash), so a request from another network is refused. Runs the real sender (Peer.httpCall),
 * the real auth middleware and the real RPC route.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"
import forge from "node-forge"
import { mockCore } from "src/utilities/testSupport/coreMocks"

const pair = forge.pki.ed25519.generateKeyPair()
const PUBKEY = Buffer.from(pair.publicKey).toString("hex")
const SENDER = "0x" + PUBKEY
const IDENTITY = "ed25519:" + SENDER
const OUR_GENESIS = "d5".repeat(32)
const OTHER_GENESIS = "e7".repeat(32)

const sharedState: Record<string, any> = {
    signingAlgorithm: "ed25519",
    lastBlockNumber: 10,
    keypair: { publicKey: new Uint8Array(32).fill(7) },
    publicKeyHex: "07".repeat(32),
    SUDO_PUBKEY: "",
    connectionString: "http://us:53550",
    genesisBlockHash: OUR_GENESIS,
    serverPort: 0,
    rateLimitConfig: {
        enabled: true,
        defaultLimit: { maxRequests: 10_000, windowMs: 60_000 },
        blockDurationMs: 60_000,
        whitelistedIPs: [],
        whitelistedKeys: [],
        methodLimits: {},
        txPerBlock: 1_000,
    },
}

mockCore(sharedState, { asInstance: true })
// Without Postgres the datasource retries for about half a minute; fail at
// once so a handler that reaches the database answers within the test timeout.
jest.mock("src/model/datasource", () => ({
    __esModule: true,
    dataSource: {},
    default: {
        getInstance: async () => {
            throw new Error("no database in this test")
        },
    },
}))
jest.mock("src/libs/blockchain/validation/txValidatorPool", () => ({
    __esModule: true,
    default: {
        getInstance: () => ({
            sign: async (_alg: string, data: Uint8Array) => ({
                signature: new Uint8Array(
                    forge.pki.ed25519.sign({
                        message: Buffer.from(data),
                        privateKey: pair.privateKey,
                    }),
                ),
            }),
            verify: async (signed: any) =>
                forge.pki.ed25519.verify({
                    message: Buffer.from(signed.message),
                    signature: Buffer.from(signed.signature) as any,
                    publicKey: Buffer.from(signed.publicKey) as any,
                }),
        }),
    },
}))
const encryption = await import("@kynesyslabs/demosdk/encryption")
jest.mock("@kynesyslabs/demosdk/encryption", () => ({
    ...encryption,
    ucrypto: {
        ...encryption.ucrypto,
        getIdentity: async () => ({ publicKey: new Uint8Array(pair.publicKey) }),
    },
}))
const forks = await import("src/forks")
jest.mock("src/forks", () => ({ ...forks, isForkActive: () => true }))
jest.mock("src/libs/consensus/stakedSet", () => ({
    getStakedSet: async () => new Set<string>(),
    getStakedSetHeight: () => 0,
    isStaked: async () => false,
    isSelfStaked: async () => false,
    onSelfStakeChange: () => () => undefined,
    invalidateStakedSet: () => undefined,
    __resetStakedSet: () => undefined,
}))

const dispatched: { method: string; sender: string; params: unknown }[] = []
const rpcDispatch = await import("./rpcDispatch")
jest.mock("./rpcDispatch", () => ({
    ...rpcDispatch,
    processPayload: async (payload: any, sender: string) => {
        dispatched.push({ method: payload.method, sender, params: payload.params })
        return { result: 200, response: "ok", require_reply: false, extra: null }
    },
}))

let captured: { data: string; headers: Record<string, string> } | null = null
const axios = (await import("axios")).default
;(axios as any).post = async (_url: string, data: any, config: any) => {
    captured = { data, headers: config.headers }
    return { data: { result: 200, response: "ok", require_reply: false, extra: null } }
}

const { BunServer } = await import("./bunServer")
BunServer.prototype.start = function () {
    return null as any
}

const { serverRpcBun } = await import("./server_rpc")
const { default: Peer } = await import("src/libs/peer/Peer")
const Hashing = (await import("src/libs/crypto/hashing")).default
const { bodyBoundAuthHeaders } = await import("./peerHttpAuth")

const server: any = await serverRpcBun()
const fakeServer = { requestIP: () => ({ address: "198.51.100.7" }) }
server.server = fakeServer

async function deliver(body: string, headers: Record<string, string>) {
    const req = new Request("http://node/", {
        method: "POST",
        body,
        headers: {
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(body)),
            ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)])),
        },
    })
    return (server as any).handleRequest(req, fakeServer) as Promise<Response>
}

async function capture(request: any) {
    captured = null
    const peer = new Peer("http://peer.example:53550", "0x" + "ee".repeat(32))
    await peer.httpCall(request, true)
    if (!captured) throw new Error("nothing sent")
    const body = typeof captured.data === "string" ? captured.data : JSON.stringify(captured.data)
    return { body, headers: captured.headers }
}

const hello = (url: string) => ({
    method: "hello_peer",
    params: [{ url, publicKey: PUBKEY }],
})

beforeEach(() => {
    dispatched.length = 0
    sharedState.genesisBlockHash = OUR_GENESIS
})

describe("peer HTTP auth", () => {
    it("delivers a peer request as sent, as its signer", async () => {
        const { body, headers } = await capture(hello("http://me.example:53550"))
        const res = await deliver(body, headers)
        expect(res.status).toBe(200)
        expect(dispatched).toEqual([
            { method: "hello_peer", sender: SENDER, params: hello("http://me.example:53550").params },
        ])
    })

    it("refuses captured headers on a swapped body", async () => {
        const { headers } = await capture(hello("http://me.example:53550"))
        const swapped = JSON.stringify(hello("http://attacker.example:53550"))
        await deliver(swapped, headers)
        expect(dispatched.filter(d => d.sender === SENDER)).toEqual([])
    })

    it("refuses a peer method signed in the old form, which leaves the body unsigned", async () => {
        const timestamp = String(Date.now())
        const signature = Buffer.from(
            forge.pki.ed25519.sign({
                message: Buffer.from(Hashing.sha256(`${IDENTITY}:${timestamp}`)),
                privateKey: pair.privateKey,
            }),
        ).toString("hex")
        const body = JSON.stringify(hello("http://attacker.example:53550"))
        await deliver(body, { identity: IDENTITY, signature, timestamp })
        expect(dispatched.filter(d => d.sender === SENDER)).toEqual([])
    })

    it("still accepts the old form for client methods", async () => {
        const timestamp = String(Date.now())
        const signature = Buffer.from(
            forge.pki.ed25519.sign({
                message: Buffer.from(Hashing.sha256(`${IDENTITY}:${timestamp}`)),
                privateKey: pair.privateKey,
            }),
        ).toString("hex")
        const body = JSON.stringify({ method: "nodeCall", params: [{ message: "getLastBlockNumber" }] })
        const res = await deliver(body, { identity: IDENTITY, signature, timestamp })
        expect(res.status).toBe(200)
        expect(dispatched).toEqual([
            { method: "nodeCall", sender: SENDER, params: [{ message: "getLastBlockNumber" }] },
        ])
    })

    it("refuses a peer request signed on another network", async () => {
        sharedState.genesisBlockHash = OTHER_GENESIS
        const { body, headers } = await capture(hello("http://me.example:53550"))
        sharedState.genesisBlockHash = OUR_GENESIS
        await deliver(body, headers)
        expect(dispatched.filter(d => d.sender === SENDER)).toEqual([])
    })

    it("does not serve peer methods before the node knows its network", async () => {
        const { body, headers } = await capture(hello("http://me.example:53550"))
        sharedState.genesisBlockHash = null
        await deliver(body, headers)
        expect(dispatched.filter(d => d.sender === SENDER)).toEqual([])
    })

    it("does not sign a peer request before the node knows its network", async () => {
        sharedState.genesisBlockHash = null
        captured = null
        const peer = new Peer("http://peer.example:53550", "0x" + "ee".repeat(32))
        const reply = await peer.httpCall(hello("http://me.example:53550") as any, true)
        expect(captured).toBeNull()
        expect(reply.result).not.toBe(200)
    })

    it("refuses an exact replay of a peer request", async () => {
        const { body, headers } = await capture(hello("http://me.example:53550"))
        const first = await deliver(body, headers)
        const replay = await deliver(body, headers)
        expect(first.status).toBe(200)
        expect(replay.status).toBe(401)
        expect(dispatched).toHaveLength(1)
    })

    it("signs two identical requests sent in the same millisecond apart", async () => {
        const now = Date.now
        Date.now = () => 1_700_000_000_000 + (now() % 1)
        try {
            const a = await capture(hello("http://me.example:53550"))
            const b = await capture(hello("http://me.example:53550"))
            expect(a.headers.timestamp).not.toBe(b.headers.timestamp)
        } finally {
            Date.now = now
        }
    })
})

describe("sudo methods", () => {
    const award = { method: "awardPoints", params: [{ message: [{ address: SENDER, points: 1 }] }] }
    const sign = async (message: Uint8Array) =>
        new Uint8Array(forge.pki.ed25519.sign({ message: Buffer.from(message), privateKey: pair.privateKey }))
    const OUR_KEY = "07".repeat(32)
    const operatorHeaders = (body: string, audience: string | null = OUR_KEY, timestamp?: number) =>
        bodyBoundAuthHeaders({
            genesisHash: OUR_GENESIS,
            identity: IDENTITY,
            body,
            sign,
            audience: audience ?? undefined,
            timestamp,
        })

    for (const method of ["rate-limit/unblock", "getCampaignData", "awardPoints"]) {
        it(`refuses ${method} signed in the old form, which leaves the body unsigned`, async () => {
            const timestamp = String(Date.now())
            const signature = Buffer.from(
                forge.pki.ed25519.sign({
                    message: Buffer.from(Hashing.sha256(`${IDENTITY}:${timestamp}`)),
                    privateKey: pair.privateKey,
                }),
            ).toString("hex")
            const body = JSON.stringify({ method, params: [] })
            const res = await deliver(body, { identity: IDENTITY, signature, timestamp })
            expect(res.status).toBe(401)
            expect(dispatched).toEqual([])
        })
    }

    it("delivers a sudo call the operator tooling signs", async () => {
        const body = JSON.stringify(award)
        const res = await deliver(body, await operatorHeaders(body))
        expect(res.status).toBe(200)
        expect(dispatched).toEqual([{ method: "awardPoints", sender: SENDER, params: award.params }])
    })

    it("refuses captured sudo headers on a swapped body", async () => {
        const headers = await operatorHeaders(JSON.stringify(award))
        const swapped = JSON.stringify({
            method: "awardPoints",
            params: [{ message: [{ address: "0x" + "ab".repeat(32), points: 1_000_000 }] }],
        })
        const res = await deliver(swapped, headers)
        expect(res.status).toBe(401)
        expect(dispatched).toEqual([])
    })

    it("refuses a sudo call signed for another node", async () => {
        const body = JSON.stringify(award)
        const res = await deliver(body, await operatorHeaders(body, "0x" + "08".repeat(32)))
        expect(res.status).toBe(401)
        expect(dispatched).toEqual([])
    })

    it("refuses a sudo call that names no node", async () => {
        const body = JSON.stringify(award)
        const res = await deliver(body, await operatorHeaders(body, null))
        expect(res.status).toBe(401)
        expect(dispatched).toEqual([])
    })

    it("refuses an audience header the signature does not cover", async () => {
        const body = JSON.stringify(award)
        const headers = await operatorHeaders(body, null)
        const res = await deliver(body, { ...headers, audience: OUR_KEY })
        expect(res.status).toBe(401)
        expect(dispatched).toEqual([])
    })

    it("refuses a sudo call signed before this node started, which its replay memory never saw", async () => {
        const body = JSON.stringify(award)
        const res = await deliver(body, await operatorHeaders(body, OUR_KEY, Date.now() - 60_000))
        expect(res.status).toBe(401)
        expect(dispatched).toEqual([])
    })

    it("refuses an exact replay of a sudo call", async () => {
        const body = JSON.stringify(award)
        const headers = await operatorHeaders(body)
        expect((await deliver(body, headers)).status).toBe(200)
        expect((await deliver(body, headers)).status).toBe(401)
        expect(dispatched).toHaveLength(1)
    })
})
