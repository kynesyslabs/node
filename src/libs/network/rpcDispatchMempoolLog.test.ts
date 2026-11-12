/**
 * The mempool merge answer carries every pooled tx, an L2PS batch or an
 * encrypted L2PS envelope among them. On the launch rehearsal the whole
 * answer was written at INFO, so an entry node logged its subnet's traffic.
 * Only a count reaches INFO; the hashes go to debug, and no tx body is logged.
 */
import { beforeEach, describe, expect, it, jest, mock } from "bun:test"

const logged = { debug: [] as string[], info: [] as string[], other: [] as string[] }
const capture = (into: string[]) => (...args: unknown[]) => {
    into.push(args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" "))
}
const SECRET = "inner-transfer-plaintext"
const pooled = [
    {
        hash: "aa".repeat(32),
        content: { type: "l2psBatch", data: ["l2psBatch", { encrypted_batch: SECRET }] },
    },
    {
        hash: "bb".repeat(32),
        content: { type: "l2psEncryptedTx", to: "0x" + "cd".repeat(32), data: ["l2psEncryptedTx", { blob: SECRET }] },
    },
]
const handleMempool = jest.fn(async () => ({
    result: 200,
    response: { txs: pooled, peerlist: [] },
    require_reply: false,
    extra: null,
}))

mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: capture(logged.debug),
        info: capture(logged.info),
        only: capture(logged.info),
        warn: capture(logged.other),
        warning: capture(logged.other),
        error: capture(logged.other),
    },
}))
mock.module("src/utilities/sharedState", () => ({ getSharedState: { SUDO_PUBKEY: "" } }))
mock.module("../peer", () => ({ PeerManager: { getInstance: () => ({ updatePeerLastSeen: () => undefined }) } }))
mock.module("./endpointHandlers", () => ({ __esModule: true, default: { handleMempool } }))
mock.module("./manageAuth", () => ({ manageAuth: jest.fn() }))
mock.module("./manageConsensusRoutines", () => ({ __esModule: true, default: jest.fn() }))
mock.module("./manageGCRRoutines", () => ({ __esModule: true, default: jest.fn() }))
mock.module("./manageExecution", () => ({ manageExecution: jest.fn() }))
mock.module("./manageHelloPeer", () => ({ manageHelloPeer: jest.fn() }))
mock.module("./manageLogin", () => ({ handleLoginRequest: jest.fn(), handleLoginResponse: jest.fn() }))
mock.module("./manageNodeCall", () => ({ manageNodeCall: jest.fn() }))
mock.module("./routines/transactions/handleWeb2ProxyRequest", () => ({ handleWeb2ProxyRequest: jest.fn() }))
mock.module("../utils/web2RequestUtils", () => ({ parseWeb2ProxyRequest: jest.fn() }))
mock.module("./manageBridge", () => ({ __esModule: true, default: jest.fn() }))
mock.module("./manageNativeBridge", () => ({ manageNativeBridge: jest.fn() }))
mock.module("./middleware/rateLimiter", () => ({ RateLimiter: class {} }))
mock.module("../blockchain/gcr/gcr", () => ({ __esModule: true, default: {} }))
mock.module("@/features/zk/proof/ProofVerifier", () => ({ ProofVerifier: class {} }))
mock.module("@/model/datasource", () => ({ __esModule: true, default: {} }))

const { processPayload } = await import("./rpcDispatch")

beforeEach(() => {
    logged.debug.length = 0
    logged.info.length = 0
    logged.other.length = 0
})

describe("the mempool merge log", () => {
    it("writes no tx body at INFO or above, and the hashes only at debug", async () => {
        const res = await processPayload({ method: "mempool", params: [] } as any, "0x" + "11".repeat(32))
        expect(res.result).toBe(200)

        const loud = [...logged.info, ...logged.other].join("\n")
        expect(loud).not.toContain(SECRET)
        expect(loud).not.toContain("l2psEncryptedTx")
        expect(loud).not.toContain(pooled[0].hash)
        expect(loud).toContain("2 txs")

        const quiet = logged.debug.join("\n")
        expect(quiet).toContain(pooled[0].hash)
        expect(quiet).toContain(pooled[1].hash)
        expect(quiet).not.toContain(SECRET)
    })
})
