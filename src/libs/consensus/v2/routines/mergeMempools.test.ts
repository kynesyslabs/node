/**
 * The pool goes to each peer in requests the receiver accepts, even when the
 * pool is larger than the admission caps.
 */

import { beforeEach, describe, expect, it, jest, mock } from "bun:test"

const OWN = "0xown"
const quietLog = {
    debug: jest.fn(),
    info: jest.fn(),
    warning: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    only: jest.fn(),
    custom: jest.fn(),
}
const received: Array<unknown[]> = []

mock.module("src/utilities/logger", () => ({ __esModule: true, default: quietLog }))
mock.module("@/utilities/logger", () => ({ __esModule: true, default: quietLog }))
mock.module("src/utilities/sharedState", () => ({
    getSharedState: { publicKeyHex: OWN },
}))
mock.module("@/utilities/sharedState", () => ({
    getSharedState: { publicKeyHex: OWN },
}))
mock.module("./peerlistMerge", () => ({
    contributePeerlist: jest.fn(),
    getLocalSyncObservations: () => [],
}))
mock.module("src/features/metrics/MetricsService", () => ({
    getMetricsService: () => ({
        createCounter: () => undefined,
        incrementCounter: () => undefined,
    }),
}))
mock.module("@/libs/blockchain/mempool", () => ({
    __esModule: true,
    default: {
        receive: jest.fn(async (txs: unknown[]) => {
            received.push(txs)
            return { success: true, mempool: [] }
        }),
    },
}))

const { __resetMempoolLimits, __setMempoolLimits } = await import(
    "@/libs/blockchain/mempoolLimits"
)
const { mergeMempools } = await import("./mergeMempools")

const tx = (hash: string) =>
    ({ hash, content: { from: "0xa" }, signature: {} }) as never

function fakePeer(identity: string, reply: (sent: any) => any) {
    const requests: any[] = []
    return {
        requests,
        identity,
        connection: { string: `http://${identity}` },
        longCall: jest.fn(async (request: any) => {
            requests.push(request.params[0])
            return reply(request.params[0])
        }),
    } as any
}

const ok = (txs: unknown[] = []) => ({
    result: 200,
    response: { txs, peerlist: [] },
    require_reply: false,
    extra: "",
})

beforeEach(() => {
    received.length = 0
    __resetMempoolLimits()
})

describe("mergeMempools batching", () => {
    it("sends a pool within the caps as one request", async () => {
        const peer = fakePeer("0xp1", () => ok())
        await mergeMempools([tx("a"), tx("b")], [peer], 7)
        expect(peer.requests).toHaveLength(1)
        expect(peer.requests[0].txs).toHaveLength(2)
        expect(peer.requests[0].blockRef).toBe(7)
    })

    it("sends an empty pool as one empty request so the peer's pool still comes back", async () => {
        const peer = fakePeer("0xp1", () => ok([tx("theirs")]))
        await mergeMempools([], [peer], 7)
        expect(peer.requests).toHaveLength(1)
        expect(received[0]).toHaveLength(1)
    })

    it("splits a pool above the request cap and sends every tx exactly once to each peer", async () => {
        __setMempoolLimits({ maxTxs: 2 })
        const pool = ["a", "b", "c", "d", "e"].map(tx)
        const p1 = fakePeer("0xp1", () => ok())
        const p2 = fakePeer("0xp2", () => ok())
        await mergeMempools(pool, [p1, p2], 7)
        for (const peer of [p1, p2]) {
            expect(peer.requests.map((r: any) => r.txs.length)).toEqual([2, 2, 1])
            expect(peer.requests.flatMap((r: any) => r.txs.map((t: any) => t.hash))).toEqual([
                "a", "b", "c", "d", "e",
            ])
        }
    })

    it("collects the txs peers return across all of their responses, once each", async () => {
        __setMempoolLimits({ maxTxs: 1 })
        const peer = fakePeer("0xp1", () => ok([tx("x"), tx("y")]))
        await mergeMempools([tx("a"), tx("b")], [peer], 7)
        expect(received).toHaveLength(1)
        expect((received[0] as Array<{ hash: string }>).map(t => t.hash).sort()).toEqual(["x", "y"])
    })

    it("stops sending to a peer that fails, without affecting the others", async () => {
        __setMempoolLimits({ maxTxs: 1 })
        const bad = fakePeer("0xbad", () => ({ result: 400, response: "no", require_reply: false, extra: "" }))
        const good = fakePeer("0xgood", () => ok())
        await mergeMempools([tx("a"), tx("b"), tx("c")], [bad, good], 7)
        expect(bad.requests).toHaveLength(1)
        expect(good.requests).toHaveLength(3)
    })
})
