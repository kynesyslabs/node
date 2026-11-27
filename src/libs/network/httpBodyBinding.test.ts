/**
 * A peer's HTTP auth headers sign the request body, so a captured request
 * cannot be replayed with another body. The signature also names the
 * network (genesis hash), so a request from another network is refused, and
 * the node it is for, so a request sent to one node is refused by the others.
 * Runs the real sender (Peer.httpCall), the real auth middleware and the real
 * RPC route.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest, setSystemTime, spyOn } from "bun:test"
import forge from "node-forge"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mockCore } from "src/utilities/testSupport/coreMocks"

const pair = forge.pki.ed25519.generateKeyPair()
const PUBKEY = Buffer.from(pair.publicKey).toString("hex")
const SENDER = "0x" + PUBKEY
const IDENTITY = "ed25519:" + SENDER
const OUR_GENESIS = "d5".repeat(32)
const OTHER_GENESIS = "e7".repeat(32)
// The node under test, and another node a request can be signed for.
const OUR_NODE = "07".repeat(32)
const OTHER_NODE = "0x" + "EE".repeat(32)

const sharedState: Record<string, any> = {
    signingAlgorithm: "ed25519",
    lastBlockNumber: 10,
    keypair: { publicKey: new Uint8Array(32).fill(7) },
    publicKeyHex: OUR_NODE,
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
// The validators at the head: none, until a test stakes the sender.
const staked = new Set<string>()
jest.mock("src/libs/consensus/stakedSet", () => ({
    getStakedSet: async () => staked,
    getStakedSetHeight: () => 0,
    isStaked: async (key: string) => staked.has(key.toLowerCase()),
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
const { PROCESS_START_MONO_MS, PROCESS_START_MS, seenAuthMessages } = await import("./verifySignature")
const { sudoFloorPath } = await import("./sudoReplayFloor")
const { RateLimiter: rateLimiter } = await import("./middleware/rateLimiter")
const { RATE_LIMIT_AUTH_FAILURE_MAX_REQUESTS, RATE_LIMIT_AUTH_FAILURE_WINDOW_MS } = await import(
    "src/utilities/constants"
)
const { Config: config } = await import("src/config")
const PUBLIC_BODY_LIMIT = config.getInstance().server.rpcMaxBodyBytes

const server: any = await serverRpcBun()
// The address a request arrives from: the sender's, unless a test says otherwise.
const SENDER_ADDRESS = "198.51.100.7"
let arrivesFrom = SENDER_ADDRESS
const fakeServer = { requestIP: () => ({ address: arrivesFrom }) }
server.server = fakeServer

async function deliver(body: string, headers: Record<string, string>, from = SENDER_ADDRESS) {
    arrivesFrom = from
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

/** What Peer.httpCall sends to the node holding `recipient`: by default, us. */
async function capture(request: any, recipient = OUR_NODE) {
    captured = null
    const peer = new Peer("http://peer.example:53550", recipient)
    await peer.httpCall(request, true)
    if (!captured) throw new Error("nothing sent")
    const body = typeof captured.data === "string" ? captured.data : JSON.stringify(captured.data)
    return { body, headers: captured.headers }
}

const hello = (url: string) => ({
    method: "hello_peer",
    params: [{ url, publicKey: PUBKEY }],
})

const signAsSender = async (message: Uint8Array) =>
    new Uint8Array(forge.pki.ed25519.sign({ message: Buffer.from(message), privateKey: pair.privateKey }))

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

    it("names the node it is for, and only that node takes it", async () => {
        const { body, headers } = await capture(hello("http://me.example:53550"), OTHER_NODE)
        expect(headers.audience).toBe("ee".repeat(32))
        const res = await deliver(body, headers)
        expect(res.status).toBe(401)
        expect(dispatched).toEqual([])
    })

    it("is not taken by another node when the header naming its node is left out", async () => {
        const { body, headers } = await capture(hello("http://me.example:53550"), OTHER_NODE)
        const unnamed = Object.fromEntries(Object.entries(headers).filter(([name]) => name !== "audience"))
        const res = await deliver(body, unnamed)
        expect(res.status).toBe(401)
        expect(dispatched).toEqual([])
    })

    for (const method of ["hello_peer", "mempool", "consensus_routine"]) {
        it(`refuses ${method} signed over its body but for no node in particular`, async () => {
            const body = JSON.stringify({ method, params: [{ url: "http://me.example:53550", publicKey: PUBKEY }] })
            const headers = await bodyBoundAuthHeaders({
                genesisHash: OUR_GENESIS,
                identity: IDENTITY,
                body,
                sign: signAsSender,
            })
            const res = await deliver(body, headers)
            expect(res.status).toBe(401)
            expect(dispatched).toEqual([])
        })
    }

    it("still takes a client method signed over its body for no node in particular", async () => {
        const body = JSON.stringify({ method: "nodeCall", params: [{ message: "getLastBlockNumber" }] })
        const headers = await bodyBoundAuthHeaders({
            genesisHash: OUR_GENESIS,
            identity: IDENTITY,
            body,
            sign: signAsSender,
        })
        const res = await deliver(body, headers)
        expect(res.status).toBe(200)
        expect(dispatched).toHaveLength(1)
    })

    it("takes a peer request dated further ahead than a sudo call may be", async () => {
        const body = JSON.stringify(hello("http://me.example:53550"))
        const headers = await bodyBoundAuthHeaders({
            genesisHash: OUR_GENESIS,
            identity: IDENTITY,
            body,
            sign: signAsSender,
            audience: OUR_NODE,
            timestamp: Date.now() + 30_000,
        })
        const res = await deliver(body, headers)
        expect(res.status).toBe(200)
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

describe("the larger body limit for validators", () => {
    // Just over the public limit, and well within the validators' one.
    const padding = "0".repeat(PUBLIC_BODY_LIMIT)
    const merge = JSON.stringify({ method: "mempool", params: [{ data: padding }] })
    const headersFor = (body: string, audience?: string) =>
        bodyBoundAuthHeaders({
            genesisHash: OUR_GENESIS,
            identity: IDENTITY,
            body,
            sign: signAsSender,
            audience,
        })

    beforeEach(() => {
        staked.add(SENDER)
    })
    afterAll(() => {
        staked.delete(SENDER)
    })

    it("covers a validator's request that names this node", async () => {
        const res = await deliver(merge, await headersFor(merge, OUR_NODE))
        expect(res.status).toBe(200)
        expect(dispatched.map(d => [d.method, d.sender])).toEqual([["mempool", SENDER]])
    })

    it("does not cover a validator's request that names no node", async () => {
        const call = JSON.stringify({
            method: "nodeCall",
            params: [{ message: "getLastBlockNumber", data: padding }],
        })
        const res = await deliver(call, await headersFor(call))
        expect(res.status).toBe(413)
        expect(dispatched).toEqual([])
    })

    it("does not cover a request that names this node from a key that is not a validator's", async () => {
        staked.delete(SENDER)
        const res = await deliver(merge, await headersFor(merge, OUR_NODE))
        expect(res.status).toBe(413)
        expect(dispatched).toEqual([])
    })
})

describe("the count of refused signatures", () => {
    const limiter = rateLimiter.getInstance()
    // An address other than the signer's that holds requests the signer sent.
    const ELSEWHERE = "203.0.113.9"
    const LIMIT = RATE_LIMIT_AUTH_FAILURE_MAX_REQUESTS
    const request = JSON.stringify(hello("http://me.example:53550"))
    const signed = (options: { audience?: string; timestamp?: number } = {}) =>
        bodyBoundAuthHeaders({
            genesisHash: OUR_GENESIS,
            identity: IDENTITY,
            body: request,
            sign: signAsSender,
            audience: OUR_NODE,
            ...options,
        })
    /** How many of `count` requests got each status, each with headers of its own. */
    const statuses = async (
        count: number,
        headers: () => Promise<Record<string, string>>,
        from = SENDER_ADDRESS,
    ) => {
        const seen: Record<number, number> = {}
        for (let i = 0; i < count; i++) {
            const { status } = await deliver(request, await headers(), from)
            seen[status] = (seen[status] ?? 0) + 1
        }
        return seen
    }
    /** What Peer.httpCall sends for a hello to the node holding `recipient`. */
    const sent = async (recipient?: string) => (await capture(hello("http://me.example:53550"), recipient)).headers
    const useLimits = (limits: Record<string, { maxRequests: number; windowMs: number }>) => {
        sharedState.rateLimitConfig.methodLimits = limits
    }
    const failureLimit = {
        "auth-failure": { maxRequests: LIMIT, windowMs: RATE_LIMIT_AUTH_FAILURE_WINDOW_MS },
    }

    for (const signer of ["a validator", "a key that is not a validator's"]) {
        describe(`for ${signer}`, () => {
            beforeEach(() => {
                useLimits(failureLimit)
                limiter.ipRequests.clear()
                if (signer === "a validator") staked.add(SENDER)
                // The limiter reads an empty validator set again only after a
                // few seconds; these tests change the set between requests.
                ;(limiter as any).validatorSetRetryAt = 0
            })
            afterEach(() => {
                staked.delete(SENDER)
                ;(limiter as any).validatorSetRetryAt = 0
            })
            afterAll(() => {
                useLimits({})
                limiter.ipRequests.clear()
            })

            it("leaves out requests the signer addressed to another node, and still serves its requests to this node", async () => {
                expect((await deliver(request, await sent())).status).toBe(200)
                expect(await statuses(LIMIT + 2, () => sent(OTHER_NODE))).toEqual({ 401: LIMIT + 2 })
                expect((await deliver(request, await sent())).status).toBe(200)
                expect(dispatched.map(d => d.sender)).toEqual([SENDER, SENDER])
            })

            it("leaves out such a request sent again from another address, however often", async () => {
                const toAnother = await sent(OTHER_NODE)
                expect(await statuses(LIMIT + 2, async () => toAnother, ELSEWHERE)).toEqual({ 401: LIMIT + 2 })
                expect((await deliver(request, await sent())).status).toBe(200)
                expect((await deliver(request, await sent(), ELSEWHERE)).status).toBe(200)
                expect(dispatched.map(d => d.sender)).toEqual([SENDER, SENDER])
            })

            it("leaves out such requests signed anew and sent from another address", async () => {
                expect(await statuses(LIMIT + 2, () => sent(OTHER_NODE), ELSEWHERE)).toEqual({ 401: LIMIT + 2 })
                expect((await deliver(request, await sent())).status).toBe(200)
                expect((await deliver(request, await sent(), ELSEWHERE)).status).toBe(200)
            })

            it("refuses a request addressed to another node with the same answer, and keeps it out of the replay memory", async () => {
                const before = seenAuthMessages.size
                const res = await deliver(request, await sent(OTHER_NODE))
                expect(res.status).toBe(401)
                expect(await res.json()).toEqual({
                    error: "Invalid signature",
                    details: "Request is for another node",
                })
                expect(seenAuthMessages.size).toBe(before)
            })

            for (const [named, audience] of [
                ["this node", OUR_NODE],
                ["another node", OTHER_NODE],
            ]) {
                it(`counts a signature that does not verify, on a request that names ${named}`, async () => {
                    const badSignature = async () => ({ ...(await signed({ audience })), signature: "5a".repeat(64) })
                    expect(await statuses(LIMIT + 2, badSignature)).toEqual({ 401: LIMIT, 429: 2 })
                    expect((await deliver(request, await sent())).status).toBe(429)
                    expect(dispatched).toEqual([])
                })

                it(`counts a timestamp outside its window, on a request that names ${named}`, async () => {
                    const stale = () => signed({ audience, timestamp: Date.now() - 6 * 60_000 })
                    expect(await statuses(LIMIT + 2, stale)).toEqual({ 401: LIMIT, 429: 2 })
                    expect((await deliver(request, await sent())).status).toBe(429)
                    expect(dispatched).toEqual([])
                })
            }

            it("counts a request that names a node but is not signed over its body", async () => {
                const unbound = async () => {
                    const { "body-hash": _hash, ...headers } = await signed({ audience: OTHER_NODE })
                    return headers
                }
                expect(await statuses(LIMIT + 2, unbound)).toEqual({ 401: LIMIT, 429: 2 })
            })

            it("holds requests addressed to another node to the limit of the address they come from", async () => {
                useLimits({ ...failureLimit, POST: { maxRequests: 3, windowMs: 60_000 } })
                expect(await statuses(5, () => sent(OTHER_NODE))).toEqual({ 401: 3, 429: 2 })
                // That limit is on the address, as for any request it sends.
                const served = signer === "a validator" ? 200 : 429
                expect((await deliver(request, await sent())).status).toBe(served)
                expect((await deliver(request, await sent(), ELSEWHERE)).status).toBe(200)
            })
        })
    }
})

describe("sudo methods", () => {
    // These run a minute after the node's start, on both clocks.
    const UPTIME = 60_000
    const NOW = PROCESS_START_MS + UPTIME
    let monotonic: ReturnType<typeof spyOn>
    let floorDir = ""
    let floors = 0
    /** A node whose durable sudo floor is `acceptedUpTo`, or unset. */
    const useFloor = (acceptedUpTo?: number) => {
        const identityFile = join(floorDir, `identity-${++floors}`)
        if (acceptedUpTo !== undefined) {
            writeFileSync(sudoFloorPath(identityFile), JSON.stringify({ acceptedUpTo }))
        }
        sharedState.identityFile = identityFile
    }
    /** What a restart loses: the in-memory replay memory. */
    const restart = () => seenAuthMessages.clear()
    beforeAll(() => {
        setSystemTime(new Date(NOW))
        monotonic = spyOn(performance, "now").mockReturnValue(PROCESS_START_MONO_MS + UPTIME)
        floorDir = mkdtempSync(join(tmpdir(), "sudo-floor-"))
        sharedState.SUDO_PUBKEY = SENDER
    })
    // Signed at the frozen clock, calls in different tests can carry the
    // same message; each test starts with an empty replay memory.
    beforeEach(() => {
        useFloor()
        restart()
    })
    afterAll(() => {
        setSystemTime()
        monotonic.mockRestore()
        rmSync(floorDir, { recursive: true, force: true })
        sharedState.SUDO_PUBKEY = ""
    })

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
        const res = await deliver(body, await operatorHeaders(body, OUR_KEY, PROCESS_START_MS - 60_000))
        expect(res.status).toBe(401)
        expect(dispatched).toEqual([])
    })

    it("refuses a sudo call dated ahead of this node's clock", async () => {
        const body = JSON.stringify(award)
        const res = await deliver(body, await operatorHeaders(body, OUR_KEY, NOW + 60_000))
        expect(res.status).toBe(401)
        expect(dispatched).toEqual([])
    })

    it("refuses, after a restart, a sudo call the previous process accepted", async () => {
        const body = JSON.stringify(award)
        const headers = await operatorHeaders(body, OUR_KEY, NOW - 1_000)
        expect((await deliver(body, headers)).status).toBe(200)
        restart()
        expect((await deliver(body, headers)).status).toBe(401)
        expect(dispatched).toHaveLength(1)
    })

    it("refuses that replay when the clock was set back before the restart", async () => {
        // The previous process accepted a call dated 30 s past this start;
        // its clock was ahead, set back, and the node restarted.
        const accepted = PROCESS_START_MS + 30_000
        useFloor(accepted)
        const body = JSON.stringify(award)
        const res = await deliver(body, await operatorHeaders(body, OUR_KEY, accepted))
        expect(res.status).toBe(401)
        expect(dispatched).toEqual([])
    })

    it("accepts a sudo call dated a little ahead, for an operator clock slightly fast", async () => {
        const body = JSON.stringify(award)
        const res = await deliver(body, await operatorHeaders(body, OUR_KEY, NOW + 1_000))
        expect(res.status).toBe(200)
    })

    it("does not let a sudo call from another key raise the floor", async () => {
        sharedState.SUDO_PUBKEY = "0x" + "99".repeat(32)
        try {
            const body = JSON.stringify(award)
            await deliver(body, await operatorHeaders(body, OUR_KEY, NOW + 4_000))
        } finally {
            sharedState.SUDO_PUBKEY = SENDER
        }
        const body = JSON.stringify(award)
        expect((await deliver(body, await operatorHeaders(body, OUR_KEY, NOW))).status).toBe(200)
    })

    describe("after the clock is set back past the node's start", () => {
        beforeAll(() => setSystemTime(new Date(NOW - 10 * 60_000)))
        afterAll(() => setSystemTime(new Date(NOW)))

        it("still accepts fresh peer requests", async () => {
            const { body, headers } = await capture(hello("http://me.example:53550"))
            const res = await deliver(body, headers)
            expect(res.status).toBe(200)
        })

        it("refuses sudo calls dated before the last one it accepted, and takes later ones", async () => {
            useFloor(NOW)
            const body = JSON.stringify(award)
            expect((await deliver(body, await operatorHeaders(body))).status).toBe(401)
            useFloor()
            expect((await deliver(body, await operatorHeaders(body))).status).toBe(200)
        })
    })

    it("refuses a sudo call accepted just before a restart, replayed once the clock is set back", async () => {
        // Accepted at S - 1 s by the old process; this one started at S and,
        // a minute later, has its clock set back by that minute.
        useFloor(PROCESS_START_MS - 1_000)
        setSystemTime(new Date(PROCESS_START_MS))
        try {
            const body = JSON.stringify(award)
            const res = await deliver(body, await operatorHeaders(body, OUR_KEY, PROCESS_START_MS - 1_000))
            expect(res.status).toBe(401)
            expect(dispatched).toEqual([])
        } finally {
            setSystemTime(new Date(NOW))
        }
    })

    it("refuses an exact replay of a sudo call", async () => {
        const body = JSON.stringify(award)
        const headers = await operatorHeaders(body)
        expect((await deliver(body, headers)).status).toBe(200)
        expect((await deliver(body, headers)).status).toBe(401)
        expect(dispatched).toHaveLength(1)
    })
})

describe("calls that hand the signer a TLSNotary proxy session", () => {
    const OUR_KEY = "07".repeat(32)
    const proxyCall = (tokenId: string) => ({
        method: "nodeCall",
        params: [{ message: "requestTLSNproxy", data: { tokenId, targetUrl: "https://example.com/" } }],
    })
    const sign = async (message: Uint8Array) =>
        new Uint8Array(forge.pki.ed25519.sign({ message: Buffer.from(message), privateKey: pair.privateKey }))
    const clientHeaders = (body: string, audience: string | null = OUR_KEY) =>
        bodyBoundAuthHeaders({
            genesisHash: OUR_GENESIS,
            identity: IDENTITY,
            body,
            sign,
            audience: audience ?? undefined,
            // The signing sequence ran ahead under the sudo tests' frozen
            // clock; a client signs at its own clock.
            timestamp: Date.now(),
        })

    it("delivers one signed over its body and naming this node", async () => {
        const body = JSON.stringify(proxyCall("ef".repeat(32)))
        const res = await deliver(body, await clientHeaders(body))
        expect(res.status).toBe(200)
        expect(dispatched).toEqual([{ method: "nodeCall", sender: SENDER, params: proxyCall("ef".repeat(32)).params }])
    })

    it("refuses one signed in the old form, which leaves the body unsigned", async () => {
        const timestamp = String(Date.now())
        const signature = Buffer.from(
            forge.pki.ed25519.sign({
                message: Buffer.from(Hashing.sha256(`${IDENTITY}:${timestamp}`)),
                privateKey: pair.privateKey,
            }),
        ).toString("hex")
        const body = JSON.stringify(proxyCall("ab".repeat(32)))
        const res = await deliver(body, { identity: IDENTITY, signature, timestamp })
        expect(res.status).toBe(401)
        expect(dispatched).toEqual([])
    })

    it("refuses one that names no node or another node", async () => {
        const body = JSON.stringify(proxyCall("ab".repeat(32)))
        expect((await deliver(body, await clientHeaders(body, null))).status).toBe(401)
        expect((await deliver(body, await clientHeaders(body, "08".repeat(32)))).status).toBe(401)
        expect(dispatched).toEqual([])
    })

    it("refuses captured headers on another body", async () => {
        const headers = await clientHeaders(JSON.stringify(proxyCall("ab".repeat(32))))
        expect((await deliver(JSON.stringify(proxyCall("cd".repeat(32))), headers)).status).toBe(401)
        expect(dispatched).toEqual([])
    })

    it("refuses an exact replay", async () => {
        const body = JSON.stringify(proxyCall("12".repeat(32)))
        const headers = await clientHeaders(body)
        expect((await deliver(body, headers)).status).toBe(200)
        expect((await deliver(body, headers)).status).toBe(401)
        expect(dispatched).toHaveLength(1)
    })
})
