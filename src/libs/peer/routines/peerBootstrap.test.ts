/**
 * peerBootstrap with the real hello verdict handling and the real genesis
 * checks: an anchor that is down does not stop the boot, a refusing one does,
 * and an anchor that comes up later gets the genesis checks bootstrap runs.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, jest, mock, setSystemTime, spyOn } from "bun:test"
import axios from "axios"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

mock.module("src/utilities/logger", () => ({
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
    genesisBlockHash: "0xchain",
    genesisCreatedThisBoot: false,
    forkConfig: {},
    chainId: null,
    getConsensusTime: () => 1,
}
mock.module("src/utilities/sharedState", () => ({ getSharedState: sharedState }))

let storedGenesis: unknown = null
mock.module("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: {
        getGenesisBlock: async () =>
            storedGenesis ? { content: { extra: { genesisData: storedGenesis } } } : null,
    },
}))

const actualUtils = await import("@kynesyslabs/demosdk/utils")
mock.module("@kynesyslabs/demosdk/utils", () => ({
    ...actualUtils,
    sleep: () => new Promise(r => setTimeout(r, 1)),
}))

const actualWatch = await import("./forkScheduleWatch")
const requestScheduleCheck = jest.fn(async () => undefined)
mock.module("./forkScheduleWatch", () => ({ ...actualWatch, requestScheduleCheck }))

const peerManagerModule = await import("../PeerManager")
const peerModule = await import("../Peer")
// eslint-disable-next-line @typescript-eslint/naming-convention
const PeerManager = peerManagerModule.default
// eslint-disable-next-line @typescript-eslint/naming-convention
const Peer = peerModule.default
const { default: log } = (await import("src/utilities/logger")) as any
const { hashGenesisData } = await import("src/libs/blockchain/genesis/normalizeGenesisForHash")
// eslint-disable-next-line @typescript-eslint/naming-convention
const { default: TxValidatorPool } = await import("src/libs/blockchain/validation/txValidatorPool")
// eslint-disable-next-line @typescript-eslint/naming-convention
const { Config } = await import("src/config")
const { forkScheduleDigest } = await import("./forkScheduleAgreement")
const signingRecord = await import("../../identity/signingRecord")
// eslint-disable-next-line @typescript-eslint/naming-convention
const { __resetSigningHalt, signingHaltReason, signingHaltMarkerPath } = signingRecord
const { BOOT_RETRY_DELAYS_MS, DEFERRED_MAX_DELAY_MS } = await import("./anchorPairing")
const {
    default: peerBootstrap,
    pendingAnchorIdentities,
    stopDeferredAnchorChecks,
} = await import("./peerBootstrap")
type HelloVerdict = import("../PeerManager").HelloVerdict
type PeerT = InstanceType<typeof Peer>

const repoGenesis = JSON.parse(
    fs.readFileSync(path.join(import.meta.dir, "../../../../data/genesis.json"), "utf8"),
)
const FILE_HASH = hashGenesisData(repoGenesis)
const OTHER_HASH = "ab".repeat(32)

const originalCwd = process.cwd()
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "peer-bootstrap-test-"))
fs.mkdirSync(path.join(workDir, "data"))
fs.writeFileSync(path.join(workDir, "data/genesis.json"), JSON.stringify(repoGenesis))

const peerman = PeerManager.getInstance()
const online = () => (peerman as any).peerList as Record<string, PeerT>

/**
 * What each anchor answers to a hello ("wire" sends `wireHello` through the
 * real hello path), and what its getGenesisDataHash call answers.
 */
let hello: Record<string, HelloVerdict | "wire">
let wireHello: { result: number; extra?: Record<string, unknown> }
let advertised: Record<string, string | { result: number }>
/** What each anchor answers to getNetworkInfo; none means no fork table. */
let networkInfo: Record<string, unknown>
const genesisQueries: string[] = []

const realSayHello = PeerManager.sayHelloToPeer.bind(PeerManager)
spyOn(PeerManager, "buildHelloRequest").mockImplementation(
    async () => ({ request: {} as any, nonce: "nonce" }),
)
const sayHello = jest.fn(async (peer: PeerT, waitForDiscovery?: boolean): Promise<HelloVerdict> => {
    const verdict = hello[peer.identity] ?? "unreachable"
    if (verdict === "wire") return realSayHello(peer, waitForDiscovery)
    if (verdict === "verified") online()[peer.identity] = peer
    return verdict
})
spyOn(PeerManager, "sayHelloToPeer").mockImplementation(sayHello as any)
spyOn(Peer.prototype, "call").mockImplementation(async function (this: PeerT, request: any) {
    if (request.method === "hello_peer") return { response: null, require_reply: false, ...wireHello } as any
    const message = request.params?.[0]?.message
    if (message === "getGenesisDataHash") {
        genesisQueries.push(this.identity)
        const answer = advertised[this.identity] ?? FILE_HASH
        return (typeof answer === "string" ? { result: 200, response: answer } : answer) as any
    }
    // Without an entry there is no fork table in the answer: the schedule is not compared.
    return { result: 200, response: networkInfo[this.identity] ?? {} } as any
})

const anchor = (n: number) => new Peer(`http://node-${n}:53550`, `0xanchor${n}`)

async function waitFor(condition: () => boolean, what: string) {
    for (let i = 0; i < 2000; i++) {
        if (condition()) return
        await new Promise(r => setTimeout(r, 1))
    }
    throw new Error("timed out waiting for " + what)
}

/** Moves the clock past any deferred backoff. */
function jumpPastBackoff() {
    setSystemTime(new Date(Date.now() + DEFERRED_MAX_DELAY_MS + 1))
}

beforeEach(() => {
    process.chdir(workDir)
    for (const key of Object.keys(online())) delete online()[key]
    ;(peerman as any).seedPeers = []
    ;(peerman as any).refusedAnchors.clear()
    online()["0xself"] = new Peer("http://self:53550", "0xself")
    hello = {}
    wireHello = { result: 503 }
    advertised = {}
    networkInfo = {}
    genesisQueries.length = 0
    requestScheduleCheck.mockClear()
    storedGenesis = repoGenesis
    sayHello.mockClear()
})

afterEach(() => {
    stopDeferredAnchorChecks()
    __resetSigningHalt()
    setSystemTime()
    process.chdir(originalCwd)
})

afterAll(() => {
    fs.rmSync(workDir, { recursive: true, force: true })
})

describe("peerBootstrap at boot", () => {
    it("boots when every anchor is down and keeps them for later", async () => {
        const peers = await peerBootstrap([anchor(1), anchor(2)])
        expect(peers.map(p => p.identity)).toEqual(["0xself"])
        expect(pendingAnchorIdentities().sort()).toEqual(["0xanchor1", "0xanchor2"])
        expect(sayHello).toHaveBeenCalledTimes(2 * (BOOT_RETRY_DELAYS_MS.length + 1))
    })

    it("boots with the anchors that answer and runs the genesis checks on them", async () => {
        hello = { "0xanchor2": "verified" }
        const peers = await peerBootstrap([anchor(1), anchor(2)])
        expect(peers.map(p => p.identity).sort()).toEqual(["0xanchor2", "0xself"])
        expect(genesisQueries).toEqual(["0xanchor2"])
        expect(pendingAnchorIdentities()).toEqual(["0xanchor1"])
    })

    it("never hellos itself", async () => {
        await peerBootstrap([new Peer("http://self:53550", "0xself")])
        expect(sayHello).not.toHaveBeenCalled()
        expect(pendingAnchorIdentities()).toEqual([])
    })

    describe("with a peer list entry that is our own address (#1159)", () => {
        const OUR_PORT = 53550

        beforeEach(() => {
            sharedState.exposedUrl = `http://localhost:${OUR_PORT}`
            sharedState.serverPort = OUR_PORT
            sharedState.identityFile = path.join(workDir, "identity")
            sharedState.prod = false
            sharedState.peerListFile = "demos_peerlist.json"
            log.warning.mockClear()
            log.error.mockClear()
            log.info.mockClear()
        })

        afterEach(() => {
            for (const key of ["exposedUrl", "serverPort", "identityFile", "prod", "peerListFile"]) delete sharedState[key]
        })

        function expectNoSigningHalt(halt: ReturnType<typeof spyOn>) {
            expect(halt).not.toHaveBeenCalled()
            expect(signingHaltReason()).toBeNull()
            expect(fs.existsSync(signingHaltMarkerPath(sharedState.identityFile))).toBe(false)
        }

        it("skips the old example, a loopback URL on our port under a key that is not ours", async () => {
            const peers = await peerBootstrap([new Peer(`http://127.0.0.1:${OUR_PORT}`, "identity")])
            expect(sayHello).not.toHaveBeenCalled()
            expect(pendingAnchorIdentities()).toEqual([])
            expect(peers.map(p => p.identity)).toEqual(["0xself"])
        })

        it("skips a loopback URL on the listener's default HTTP port", async () => {
            const previousBind = process.env.RPC_BIND
            process.env.RPC_BIND = "0.0.0.0"
            Config.resetInstance()
            try {
                sharedState.serverPort = 80
                for (const address of ["http://127.0.0.1:80", "http://127.0.0.1"]) {
                    expect(await PeerManager.urlIsOurAddress(new URL(address))).toBe(true)
                    const peers = await peerBootstrap([new Peer(address, "0xstale")])
                    expect(peers.map(p => p.identity)).toEqual(["0xself"])
                    expect(sayHello).not.toHaveBeenCalled()
                }
                sharedState.serverPort = OUR_PORT
                expect(await PeerManager.urlIsOurAddress(new URL("http://127.0.0.1:80"))).toBe(false)
                expect(await PeerManager.urlIsOurAddress(new URL("http://127.0.0.1"))).toBe(false)
            } finally {
                if (previousBind === undefined) delete process.env.RPC_BIND
                else process.env.RPC_BIND = previousBind
                Config.resetInstance()
            }
        })

        it("normalizes an expanded IPv6 wildcard before checking IPv4 loopback", async () => {
            const previousBind = process.env.RPC_BIND
            const previousProbe = (PeerManager as any).dualStackProbe
            process.env.RPC_BIND = "0:0:0:0:0:0:0:0"
            Config.resetInstance()
            ;(PeerManager as any).dualStackProbe = Promise.resolve(true)
            try {
                expect(await PeerManager.urlIsOurAddress(new URL(`http://127.0.0.1:${OUR_PORT}`))).toBe(true)
            } finally {
                (PeerManager as any).dualStackProbe = previousProbe
                if (previousBind === undefined) delete process.env.RPC_BIND
                else process.env.RPC_BIND = previousBind
                Config.resetInstance()
            }
        })

        it("keeps a seed on our port when the IPv6 bind has a zone id", async () => {
            const previousBind = process.env.RPC_BIND
            process.env.RPC_BIND = "fe80::1%eth0"
            Config.resetInstance()
            try {
                const address = `https://v1.example:${OUR_PORT}`
                expect(await PeerManager.urlIsOurAddress(new URL(address))).toBe(false)
                hello = { "0xother": "verified" }
                await peerBootstrap([new Peer(address, "0xother")])
                expect(sayHello.mock.calls.map(([peer]) => peer.identity)).toEqual(["0xother"])
            } finally {
                if (previousBind === undefined) delete process.env.RPC_BIND
                else process.env.RPC_BIND = previousBind
                Config.resetInstance()
            }
        })

        it("retries a dual-stack probe after a transient failure", async () => {
            const previousBind = process.env.RPC_BIND
            const previousProbe = (PeerManager as any).dualStackProbe
            process.env.RPC_BIND = "::"
            Config.resetInstance()
            ;(PeerManager as any).dualStackProbe = undefined
            const serve = spyOn(Bun, "serve").mockImplementation(() => ({ port: 1234, stop: jest.fn() } as any))
            const fetchMock = spyOn(globalThis, "fetch")
                .mockRejectedValueOnce(new Error("transient timeout"))
                .mockResolvedValueOnce(new Response("ok"))
            try {
                const url = new URL(`http://127.0.0.1:${OUR_PORT}`)
                expect(await PeerManager.urlIsOurAddress(url)).toBe(false)
                expect(await PeerManager.urlIsOurAddress(url)).toBe(true)
                expect(serve).toHaveBeenCalledTimes(2)
            } finally {
                fetchMock.mockRestore()
                serve.mockRestore()
                ;(PeerManager as any).dualStackProbe = previousProbe
                if (previousBind === undefined) delete process.env.RPC_BIND
                else process.env.RPC_BIND = previousBind
                Config.resetInstance()
            }
        })

        for (const bind of ["::", "0.0.0.0"]) {
            for (const reachable of [true, false]) {
                it(`${reachable ? "skips" : "keeps"} mapped loopback with RPC_BIND=${bind} when the probe is ${reachable}`, async () => {
                    const previousBind = process.env.RPC_BIND
                    const probeField = bind === "::" ? "dualStackProbe" : "mappedIpv4Probe"
                    const previousProbe = (PeerManager as any)[probeField]
                    process.env.RPC_BIND = bind
                    Config.resetInstance()
                    const serve = reachable ? undefined : spyOn(Bun, "serve").mockImplementation(() => {
                        throw new Error("probe unavailable")
                    })
                    ;(PeerManager as any)[probeField] = reachable ? Promise.resolve(true) : undefined
                    try {
                        for (const host of ["[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[::ffff:127.2.3.4]"]) {
                            const url = new URL(`http://${host}:${OUR_PORT}`)
                            expect(await PeerManager.urlIsOurAddress(url)).toBe(reachable)
                            expect(await PeerManager.urlIsOurAddress(new URL(`http://${host}:${OUR_PORT + 1}`))).toBe(false)
                        }
                        expect(await PeerManager.urlIsOurAddress(new URL(`http://[::ffff:10.0.0.1]:${OUR_PORT}`))).toBe(false)
                        hello = { "0xother": "verified" }
                        await peerBootstrap([new Peer(`http://[::ffff:127.0.0.1]:${OUR_PORT}`, "0xother")])
                        expect(sayHello.mock.calls.map(([peer]) => peer.identity)).toEqual(
                            reachable ? [] : ["0xother"],
                        )
                    } finally {
                        serve?.mockRestore()
                        ;(PeerManager as any)[probeField] = previousProbe
                        if (previousBind === undefined) delete process.env.RPC_BIND
                        else process.env.RPC_BIND = previousBind
                        Config.resetInstance()
                    }
                })
            }
        }

        it("skips our public key in the peer list regardless of case", async () => {
            await peerBootstrap([new Peer("http://10.0.0.5:53550", "0xSELF")])
            expect(sayHello).not.toHaveBeenCalled()
            expect(pendingAnchorIdentities()).toEqual([])
        })

        it("refuses a signed self reply from an unrecognized address", async () => {
            const selfKey = "0x" + "ab".repeat(32)
            sharedState.publicKeyHex = selfKey
            sharedState.exposedUrl = "https://node.example.org"
            delete online()["0xself"]
            online()[selfKey] = new Peer(sharedState.exposedUrl, selfKey)
            hello = { "0xstale": "wire" }
            wireHello = {
                result: 200,
                extra: {
                    msg: "Peer is us: skipping",
                    identity: selfKey,
                    url: sharedState.exposedUrl,
                    signature: { type: "ed25519", data: "aa" },
                },
            }
            const verify = spyOn(TxValidatorPool.getInstance(), "verify").mockResolvedValue(true)
            const halt = spyOn(signingRecord, "haltSigning")
            const seed = new Peer(`http://10.0.0.5:${OUR_PORT}`, "0xstale")
            ;(peerman as any).seedPeers = [seed]
            try {
                await expect(peerBootstrap([seed]))
                    .rejects.toThrow("failed identity verification")
                expect(sayHello).toHaveBeenCalledTimes(1)
                expect(verify).toHaveBeenCalledTimes(1)
                expect(log.error).toHaveBeenCalledWith(
                    `[PEERMANAGER] http://10.0.0.5:${OUR_PORT} answered with this node's signed identity (this node reached through another address, a copy of this node, or a relay); remove that peer-list entry`,
                )
                expectNoSigningHalt(halt)
                expect(log.warning.mock.calls.some((call: unknown[]) =>
                    String(call[0]).startsWith("[PEERMANAGER] http://10.0.0.5:"),
                )).toBe(false)
            } finally {
                halt.mockRestore()
                verify.mockRestore()
                sharedState.publicKeyHex = "0xself"
            }
        })

        it("refuses a seed that answers with our key for another URL, without claiming an unverified identity", async () => {
            const selfKey = "0x" + "ab".repeat(32)
            sharedState.publicKeyHex = selfKey
            sharedState.exposedUrl = `https://node.example.org:${OUR_PORT}`
            hello = { "0xstale": "wire" }
            wireHello = {
                result: 200,
                extra: {
                    msg: "Peer is us: skipping",
                    identity: selfKey,
                    url: `https://node-b.example:${OUR_PORT}`,
                    signature: { type: "ed25519", data: "aa" },
                },
            }
            const verify = spyOn(TxValidatorPool.getInstance(), "verify").mockResolvedValue(true)
            const halt = spyOn(signingRecord, "haltSigning")
            const seed = new Peer(`https://node-b.example:${OUR_PORT}`, "0xstale")
            ;(peerman as any).seedPeers = [seed]
            try {
                await expect(peerBootstrap([seed])).rejects.toThrow("failed identity verification")
                expect(verify).not.toHaveBeenCalled()
                expect(log.warning).toHaveBeenCalledWith(
                    `[PEERMANAGER] ${seed.connection.string} answered "Peer is us" without a valid proof for our URL ${sharedState.exposedUrl}: dropping bogus peer 0xstale`,
                )
                expect(log.error.mock.calls.some((call: unknown[]) =>
                    String(call[0]).startsWith("[PEERMANAGER]"),
                )).toBe(false)
                expectNoSigningHalt(halt)
            } finally {
                halt.mockRestore()
                verify.mockRestore()
                sharedState.publicKeyHex = "0xself"
            }
        })

        it("warns without halting signing when a runtime hello reaches our public URL", async () => {
            const selfKey = "0x" + "ab".repeat(32)
            sharedState.publicKeyHex = selfKey
            sharedState.exposedUrl = `https://node.example.org:${OUR_PORT}`
            const peer = new Peer(sharedState.exposedUrl, "0xstale")
            const verify = spyOn(TxValidatorPool.getInstance(), "verify").mockResolvedValue(true)
            const halt = spyOn(signingRecord, "haltSigning")
            try {
                const answer = await PeerManager.helloPeerCallback({
                    result: 200,
                    extra: {
                        msg: "Peer is us: skipping",
                        identity: selfKey,
                        url: sharedState.exposedUrl,
                        signature: { type: "ed25519", data: "aa" },
                    },
                } as any, peer, "nonce")
                expect(answer.verdict).toBe("invalid")
                expect(log.error).not.toHaveBeenCalled()
                expect(log.warning).toHaveBeenCalledWith(
                    `[PEERMANAGER] ${peer.connection.string} answered as ourselves: dropping bogus peer ${peer.identity}`,
                )
                expectNoSigningHalt(halt)
            } finally {
                halt.mockRestore()
                verify.mockRestore()
                sharedState.publicKeyHex = "0xself"
            }
        })

        it("dials localhost on a wildcard bind and refuses a signed self reply without halting signing", async () => {
            const selfKey = "0x" + "ab".repeat(32)
            sharedState.publicKeyHex = selfKey
            sharedState.exposedUrl = "https://node.example.org"
            hello = { "0xstale": "wire" }
            wireHello = {
                result: 200,
                extra: {
                    msg: "Peer is us: skipping",
                    identity: selfKey,
                    url: sharedState.exposedUrl,
                    signature: { type: "ed25519", data: "aa" },
                },
            }
            const peer = new Peer(`http://localhost:${OUR_PORT}`, "0xstale")
            ;(peerman as any).seedPeers = [peer]
            const verify = spyOn(TxValidatorPool.getInstance(), "verify").mockResolvedValue(true)
            const halt = spyOn(signingRecord, "haltSigning")
            try {
                await expect(peerBootstrap([peer])).rejects.toThrow("failed identity verification")
                expect(sayHello.mock.calls.map(([p]) => p.identity)).toEqual(["0xstale"])
                expect(log.error).toHaveBeenCalledWith(
                    `[PEERMANAGER] ${peer.connection.string} answered with this node's signed identity (this node reached through another address, a copy of this node, or a relay); remove that peer-list entry`,
                )
                expectNoSigningHalt(halt)
            } finally {
                halt.mockRestore()
                verify.mockRestore()
                sharedState.publicKeyHex = "0xself"
            }
        })

        it("accepts a signed self reply only at the exact RPC bind address", async () => {
            const previousBind = process.env.RPC_BIND
            process.env.RPC_BIND = "10.0.0.5"
            Config.resetInstance()
            const selfKey = "0x" + "ab".repeat(32)
            sharedState.publicKeyHex = selfKey
            sharedState.exposedUrl = "https://node.example.org"
            const verify = spyOn(TxValidatorPool.getInstance(), "verify").mockResolvedValue(true)
            try {
                const answer = await PeerManager.helloPeerCallback({
                    result: 200,
                    extra: {
                        msg: "Peer is us: skipping",
                        identity: selfKey,
                        url: sharedState.exposedUrl,
                        signature: { type: "ed25519", data: "aa" },
                    },
                } as any, new Peer(`http://10.0.0.5:${OUR_PORT}`, "0xstale"), "nonce")
                expect(answer.verdict).toBe("self")
                expect(log.error).not.toHaveBeenCalled()
            } finally {
                verify.mockRestore()
                sharedState.publicKeyHex = "0xself"
                if (previousBind === undefined) delete process.env.RPC_BIND
                else process.env.RPC_BIND = previousBind
                Config.resetInstance()
            }
        })

        it("does not treat a production loopback on another port as its own listener", async () => {
            sharedState.prod = true
            sharedState.exposedUrl = "https://node.example.org"
            sharedState.publicKeyHex = "0x" + "ab".repeat(32)
            const verify = spyOn(TxValidatorPool.getInstance(), "verify").mockResolvedValue(true)
            try {
                const answer = await PeerManager.helloPeerCallback({
                    result: 200,
                    extra: {
                        msg: "Peer is us: skipping",
                        identity: sharedState.publicKeyHex,
                        url: sharedState.exposedUrl,
                        signature: { type: "ed25519", data: "aa" },
                    },
                } as any, new Peer(`http://127.0.0.1:${OUR_PORT + 1}`, "0xstale"), "nonce")
                expect(answer.verdict).toBe("invalid")
                expect(signingHaltReason()).toBeNull()
            } finally {
                verify.mockRestore()
                sharedState.publicKeyHex = "0xself"
            }
        })

        it("still refuses an unsigned self claim from a LAN alias", async () => {
            sharedState.exposedUrl = "https://node.example.org"
            hello = { "0xstale": "wire" }
            wireHello = { result: 200, extra: { msg: "Peer is us: skipping" } }
            await expect(peerBootstrap([new Peer(`http://10.0.0.5:${OUR_PORT}`, "0xstale")]))
                .rejects.toThrow("failed identity verification")
        })

        it("keeps a loopback anchor reached through a tunnel when RPC binds to a private interface", async () => {
            const previousBind = process.env.RPC_BIND
            process.env.RPC_BIND = "10.0.0.5"
            Config.resetInstance()
            try {
                hello = { "0xtunnel": "verified" }
                const peers = await peerBootstrap([new Peer(`http://127.0.0.1:${OUR_PORT}`, "0xtunnel")])
                expect(sayHello.mock.calls.map(([p]) => p.identity)).toEqual(["0xtunnel"])
                expect(peers.map(p => p.identity).sort()).toEqual(["0xself", "0xtunnel"])
            } finally {
                if (previousBind === undefined) delete process.env.RPC_BIND
                else process.env.RPC_BIND = previousBind
                Config.resetInstance()
            }
        })

        it("keeps a sibling loopback anchor when RPC binds to one specific loopback address", async () => {
            const previousBind = process.env.RPC_BIND
            process.env.RPC_BIND = "127.0.0.1"
            Config.resetInstance()
            try {
                hello = { "0xsibling4": "verified" }
                const peers = await peerBootstrap([
                    new Peer(`http://127.0.0.2:${OUR_PORT}`, "0xsibling4"),
                ])
                expect(sayHello.mock.calls.map(([p]) => p.identity)).toEqual(["0xsibling4"])
                expect(peers.map(p => p.identity).sort()).toEqual(["0xself", "0xsibling4"])
            } finally {
                if (previousBind === undefined) delete process.env.RPC_BIND
                else process.env.RPC_BIND = previousBind
                Config.resetInstance()
            }
        })

        for (const [bind, host, skipped] of [
            ["0.0.0.0", "127.0.0.2", true],
            ["::", "[::1]", true],
            ["::", "127.0.0.1", true],
            ["0.0.0.0", "host.docker.internal", false],
            ["0.0.0.0", "host.docker.internal.", false],
            ["::", "host.docker.internal", false],
            ["localhost", "localhost", true],
            ["localhost", "127.0.0.1", false],
            ["localhost", "[::1]", false],
            ["localhost", "[::ffff:127.0.0.1]", false],
            ["127.0.0.1", "localhost", false],
            ["127.0.0.1", "[::1]", false],
            ["10.0.0.5", "[::ffff:127.0.0.1]", false],
            ["::1", "127.0.0.1", false],
            ["::1", "[::1]", true],
            ["0.0.0.0", "[::1]", false],
            ["127.0.0.1", "127.0.0.2", false],
            ["10.0.0.5", "10.0.0.5", true],
            ["10.0.0.5", "127.0.0.1", false],
            ["2001:db8::5", "[2001:db8::5]", true],
        ] as const) {
            it(`${skipped ? "skips" : "keeps"} ${host} with RPC_BIND=${bind}`, async () => {
                const previousBind = process.env.RPC_BIND
                process.env.RPC_BIND = bind
                Config.resetInstance()
                try {
                    sharedState.exposedUrl = "https://node.example.org:8443"
                    hello = { "0xother": "verified" }
                    await peerBootstrap([new Peer(`http://${host}:${OUR_PORT}`, "0xother")])
                    expect(sayHello.mock.calls.map(([peer]) => peer.identity)).toEqual(
                        skipped ? [] : ["0xother"],
                    )
                } finally {
                    if (previousBind === undefined) delete process.env.RPC_BIND
                    else process.env.RPC_BIND = previousBind
                    Config.resetInstance()
                }
            })
        }

        it("dials a production loopback peer on another port", async () => {
            sharedState.prod = true
            hello = { "0xsibling": "verified" }
            await peerBootstrap([new Peer(`http://127.0.0.1:${OUR_PORT + 1}`, "0xsibling")])
            expect(sayHello.mock.calls.map(([peer]) => peer.identity)).toEqual(["0xsibling"])
        })

        it("dials our public URL under a stale key and refuses a signed self reply", async () => {
            const selfKey = "0x" + "ab".repeat(32)
            sharedState.publicKeyHex = selfKey
            sharedState.exposedUrl = `https://node.example.org:${OUR_PORT}`
            hello = { "0xtwin": "wire" }
            wireHello = {
                result: 200,
                extra: {
                    msg: "Peer is us: skipping",
                    identity: selfKey,
                    url: sharedState.exposedUrl,
                    signature: { type: "ed25519", data: "aa" },
                },
            }
            const twin = new Peer(sharedState.exposedUrl, "0xtwin")
            const verify = spyOn(TxValidatorPool.getInstance(), "verify").mockResolvedValue(true)
            const halt = spyOn(signingRecord, "haltSigning")
            try {
                await expect(peerBootstrap([twin])).rejects.toThrow("failed identity verification")
                expect(sayHello.mock.calls.map(([p]) => p.identity)).toEqual(["0xtwin"])
                expectNoSigningHalt(halt)
            } finally {
                halt.mockRestore()
                verify.mockRestore()
                sharedState.publicKeyHex = "0xself"
            }
        })

        it("keeps a loopback peer on another port, as a devnet on one host has", async () => {
            const sibling = new Peer(`http://127.0.0.1:${OUR_PORT + 1}`, "0xsibling")
            await peerBootstrap([sibling])
            expect(pendingAnchorIdentities()).toEqual(["0xsibling"])
        })

        it("says there are no usable peers instead of failing the boot", async () => {
            await peerBootstrap([new Peer(`http://127.0.0.1:${OUR_PORT}`, "identity")])
            const messages = log.warning.mock.calls.map((call: unknown[]) => String(call[0]))
            expect(messages.some((m: string) => m.includes("No usable peers in demos_peerlist.json"))).toBe(true)
            expect(messages.some((m: string) => m.includes("is this node's own address"))).toBe(true)
        })

        it("reports an intentionally empty list at info level", async () => {
            await peerBootstrap([])
            expect(log.info.mock.calls.some((call: unknown[]) => String(call[0]).includes("No usable peers"))).toBe(true)
            expect(log.warning.mock.calls.some((call: unknown[]) => String(call[0]).includes("No usable peers"))).toBe(false)
        })
    })

    for (const [verdict, text] of [
        ["unsigned", "without a signed hello"],
        ["invalid", "failed identity verification"],
        ["other-genesis", "runs another chain"],
    ] as const) {
        it(`still refuses to boot when an anchor answers ${verdict}`, async () => {
            hello = { "0xanchor2": verdict }
            await expect(peerBootstrap([anchor(1), anchor(2)])).rejects.toThrow(text)
        })
    }

    it("still refuses to boot when an anchor on another network answers the hello with 409", async () => {
        hello = { "0xanchor1": "wire" }
        wireHello = { result: 409, extra: { msg: "genesis mismatch", genesisHash: "0xother" } }
        await expect(peerBootstrap([anchor(1)])).rejects.toThrow("runs another chain")
    })

    it("leaves an anchor that answers the hello with 503 (still booting) behind", async () => {
        hello = { "0xanchor1": "wire" }
        wireHello = { result: 503, extra: { msg: "genesis not loaded yet, retry later" } }
        await peerBootstrap([anchor(1)])
        expect(pendingAnchorIdentities()).toEqual(["0xanchor1"])
    })

    it("keeps an anchor whose genesis hash it could not get for a later check, not as confirmed", async () => {
        hello = { "0xanchor1": "verified" }
        advertised = { "0xanchor1": { result: 503 } }
        const refusals: boolean[] = []
        await peerBootstrap([anchor(1), anchor(2)], {
            onLateRefusal: (_peer, _refusal, fatal) => refusals.push(fatal),
        })
        expect(pendingAnchorIdentities().sort()).toEqual(["0xanchor1", "0xanchor2"])

        // Nothing confirmed this node, so a refusal is still fatal.
        hello = { "0xanchor1": "verified", "0xanchor2": "other-genesis" }
        jumpPastBackoff()
        await waitFor(() => refusals.length > 0, "the refusal")
        expect(refusals).toEqual([true])
    })

    it("still refuses to boot when a paired anchor's genesis data conflicts with the stored block 0", async () => {
        storedGenesis = { ...repoGenesis, timestamp: 1 }
        hello = { "0xanchor1": "verified" }
        advertised = { "0xanchor1": OTHER_HASH }
        await expect(peerBootstrap([anchor(1)])).rejects.toThrow("Genesis data match failed")
        expect(online()["0xanchor1"]).toBeUndefined()
    })
})

describe("the fork schedule of a paired anchor", () => {
    const TREASURY = "0x" + "7e".repeat(32)
    const OTHER = "0x" + "11".repeat(32)
    const answering = (treasury: string) => {
        const forks = { gasFeeSeparation: { activationHeight: 0, treasuryAddress: treasury } }
        return { chainId: 7, forks, forkScheduleDigest: forkScheduleDigest(forks, 7) }
    }

    beforeEach(() => {
        sharedState.forkConfig = { gasFeeSeparation: { activationHeight: 0, treasuryAddress: TREASURY } }
        sharedState.chainId = 7
    })
    afterEach(() => {
        sharedState.forkConfig = {}
        sharedState.chainId = null
    })

    it("logs a different treasury as an error and starts a watch round at once", async () => {
        const log = (await import("src/utilities/logger")).default
        ;(log.error as any).mockClear()
        hello = { "0xanchor1": "verified" }
        networkInfo = { "0xanchor1": answering(OTHER) }
        await peerBootstrap([anchor(1)])
        const lines = (log.error as any).mock.calls.map((c: unknown[]) => String(c[0])).join("\n")
        expect(lines).toContain("gasFeeSeparation TREASURY MISMATCH with http://node-1:53550")
        expect(lines).toContain(`gasFeeSeparation.treasuryAddress: ours ${TREASURY}, theirs ${OTHER}`)
        expect(requestScheduleCheck).toHaveBeenCalledTimes(1)
    })

    it("starts no round for an anchor with the same treasury", async () => {
        hello = { "0xanchor1": "verified" }
        networkInfo = { "0xanchor1": answering(TREASURY) }
        await peerBootstrap([anchor(1)])
        expect(requestScheduleCheck).not.toHaveBeenCalled()
    })
})

describe("anchors that come up after boot", () => {
    it("get the genesis checks once they answer", async () => {
        const refusals: unknown[] = []
        await peerBootstrap([anchor(1)], { onLateRefusal: (...args) => refusals.push(args) })
        expect(genesisQueries).toEqual([])

        hello = { "0xanchor1": "verified" }
        jumpPastBackoff()
        await waitFor(() => pendingAnchorIdentities().length === 0, "the anchor to be checked")
        expect(genesisQueries).toEqual(["0xanchor1"])
        expect(refusals).toEqual([])
        expect(online()["0xanchor1"]).toBeDefined()
    })

    it("get the genesis checks right after they pair with this node by their own hello", async () => {
        await peerBootstrap([anchor(1)])
        hello = { "0xanchor1": "verified" }
        // Its own hello added it; no clock jump needed.
        online()["0xanchor1"] = anchor(1)
        await waitFor(() => genesisQueries.length > 0, "the genesis check")
        expect(genesisQueries).toEqual(["0xanchor1"])
    })

    it("stop the node when the first one to answer has conflicting genesis data", async () => {
        storedGenesis = { ...repoGenesis, timestamp: 1 }
        const refusals: { identity: string; message: string; fatal: boolean }[] = []
        await peerBootstrap([anchor(1)], {
            onLateRefusal: (peer, refusal, fatal) =>
                refusals.push({ identity: peer.identity, message: refusal.message, fatal }),
        })

        hello = { "0xanchor1": "verified" }
        advertised = { "0xanchor1": OTHER_HASH }
        jumpPastBackoff()
        await waitFor(() => refusals.length > 0, "the refusal")
        expect(refusals).toEqual([
            { identity: "0xanchor1", message: expect.stringContaining("Genesis data match failed"), fatal: true },
        ])
    })

    it("are retried, not refused, when the genesis download fails", async () => {
        // No stored block 0 and no pin: the peer's data is downloaded and compared.
        storedGenesis = null
        const get = spyOn(axios, "get").mockImplementation(async () => {
            throw new Error("timeout of 10000ms exceeded")
        })
        try {
            const refusals: unknown[] = []
            await peerBootstrap([anchor(1)], { onLateRefusal: (...args) => refusals.push(args) })
            hello = { "0xanchor1": "verified" }
            advertised = { "0xanchor1": OTHER_HASH }
            jumpPastBackoff()
            await waitFor(() => get.mock.calls.length > 0, "the download")
            await new Promise(r => setTimeout(r, 20))
            expect(refusals).toEqual([])
            expect(pendingAnchorIdentities()).toEqual(["0xanchor1"])
        } finally {
            get.mockRestore()
        }
    })

    it("stop the node when the first one to answer runs another chain", async () => {
        const refusals: boolean[] = []
        await peerBootstrap([anchor(1)], {
            onLateRefusal: (_peer, _refusal, fatal) => refusals.push(fatal),
        })
        hello = { "0xanchor1": "other-genesis" }
        jumpPastBackoff()
        await waitFor(() => refusals.length > 0, "the refusal")
        expect(refusals).toEqual([true])
    })

    it("are dropped, not fatal, when another anchor already confirmed this node", async () => {
        hello = { "0xanchor1": "verified" }
        const refusals: boolean[] = []
        await peerBootstrap([anchor(1), anchor(2)], {
            onLateRefusal: (_peer, _refusal, fatal) => refusals.push(fatal),
        })
        expect(pendingAnchorIdentities()).toEqual(["0xanchor2"])

        hello = { "0xanchor1": "verified", "0xanchor2": "verified" }
        advertised = { "0xanchor2": OTHER_HASH }
        storedGenesis = { ...repoGenesis, timestamp: 1 }
        jumpPastBackoff()
        await waitFor(() => refusals.length > 0, "the refusal")
        expect(refusals).toEqual([false])
        expect(online()["0xanchor2"]).toBeUndefined()
        expect(online()["0xanchor1"]).toBeDefined()
    })

    it("keep a dropped anchor out when it hellos this node again", async () => {
        hello = { "0xanchor1": "verified" }
        const refusals: boolean[] = []
        await peerBootstrap([anchor(1), anchor(2)], {
            onLateRefusal: (_peer, _refusal, fatal) => refusals.push(fatal),
        })
        hello = { "0xanchor1": "verified", "0xanchor2": "verified" }
        advertised = { "0xanchor2": "not-a-hash" }
        jumpPastBackoff()
        await waitFor(() => refusals.length > 0, "the refusal")
        expect(refusals).toEqual([false])

        // Its inbound hello is answered as a stranger, which needs canAddPeer
        // before any hello back; a verified hello back ends in addPeer.
        const again = anchor(2)
        expect(peerman.canAddPeer(again)[0]).toBe(false)
        expect(peerman.addPeer(again, true)[0]).toBe(false)
        expect(online()["0xanchor2"]).toBeUndefined()

        const helloCalls = () =>
            (Peer.prototype.call as any).mock.calls.filter(([r]: any[]) => r.method === "hello_peer").length
        const before = helloCalls()
        expect(await realSayHello(again)).toBe("skipped")
        expect(helloCalls()).toBe(before)

        // Other peers are unaffected.
        expect(peerman.canAddPeer(anchor(3))[0]).toBe(true)
    })
})
