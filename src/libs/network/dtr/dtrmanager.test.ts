import { DTRManager } from "./dtrmanager"
import Mempool from "@/libs/blockchain/mempool"
import Chain from "@/libs/blockchain/chain"
import log from "src/utilities/logger"

const OUR_KEY = "0a".repeat(32)

const state = {
    inConsensusLoop: false,
    lastBlockNumber: 100,
    lastBlockHash: "hash-100",
    publicKeyHex: OUR_KEY,
    signingAlgorithm: "ed25519",
    shardSize: 4,
    referenceBlockRoom: 10,
}

let pool: string[] = []
const peerMap = new Map<string, any>()
let onlinePeers: Array<{ identity: string }> = []
let lastBlockTxSet = new Set<string>()
let isNextValidator = true

jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        only: jest.fn(),
    },
}))

jest.mock("src/utilities/sharedState", () => ({
    getSharedState: {
        get inConsensusLoop() {
            return state.inConsensusLoop
        },
        get lastBlockNumber() {
            return state.lastBlockNumber
        },
        get lastBlockHash() {
            return state.lastBlockHash
        },
        get publicKeyHex() {
            return state.publicKeyHex
        },
        get signingAlgorithm() {
            return state.signingAlgorithm
        },
        get shardSize() {
            return state.shardSize
        },
        get referenceBlockRoom() {
            return state.referenceBlockRoom
        },
    },
}))

jest.mock("@/libs/peer", () => ({
    __esModule: true,
    Peer: class {},
    PeerManager: {
        getInstance: () => ({
            getPeer: (identity: string) => peerMap.get(identity),
            getOnlinePeers: async () => onlinePeers,
        }),
    },
}))

jest.mock("@/libs/blockchain/mempool", () => ({
    __esModule: true,
    default: {
        lock: {
            runExclusive: jest.fn(async (fn: () => Promise<unknown>) => fn()),
        },
        receive: jest.fn(async () => ({ success: true })),
        addTransaction: jest.fn(async () => ({
            confirmationBlock: 101,
            error: null,
        })),
    },
}))

jest.mock("@/libs/blockchain/chain", () => ({
    __esModule: true,
    default: {
        getLastBlockTransactionSet: jest.fn(async () => lastBlockTxSet),
    },
}))

jest.mock("@/libs/blockchain/validation/txValidatorPool", () => ({
    __esModule: true,
    default: {
        getInstance: () => ({
            verify: async () => true,
        }),
    },
}))

jest.mock("@/libs/blockchain/transaction", () => ({
    __esModule: true,
    default: {
        validateSignature: async () => ({ success: true }),
    },
}))

jest.mock("@/libs/consensus/v2/routines/getShard", () => ({
    __esModule: true,
    getEligiblePool: async () => pool,
}))

jest.mock("@/libs/consensus/v2/routines/isValidator", () => ({
    __esModule: true,
    default: async () => ({
        isValidator: isNextValidator,
        validators: [],
        lastBlockHash: "hash-100",
    }),
}))

jest.mock("@/errors", () => ({
    __esModule: true,
    handleError: jest.fn(),
}))

function makePeer(identity: string, ok = true) {
    return {
        identity,
        connection: { string: "http://" + identity.slice(0, 8) },
        longCall: jest.fn(async () => ({
            result: ok ? 200 : 400,
            response: { confirmationBlock: state.lastBlockNumber + 1 },
            require_reply: false,
            extra: {},
        })),
    }
}

function setupPool(size: number, opts: { failing?: number; known?: number } = {}) {
    pool = []
    peerMap.clear()
    const known = opts.known ?? size - 1
    const failing = opts.failing ?? 0

    pool.push(OUR_KEY)
    peerMap.set(OUR_KEY, makePeer(OUR_KEY))

    for (let i = 1; i < size; i++) {
        const identity = (0xb0 + i).toString(16).repeat(32)
        pool.push(identity)
        if (i <= known) {
            peerMap.set(identity, makePeer(identity, i > failing))
        }
    }
}

function totalCalls(): number {
    let calls = 0
    for (const peer of peerMap.values()) {
        calls += peer.longCall.mock.calls.length
    }
    return calls
}

function makeValidityData(hash: string, overrides: Record<string, any> = {}) {
    return {
        data: {
            transaction: {
                hash,
                content: { timestamp: 1000, nonce: 1, type: "native" },
            },
            reference_block: overrides.reference_block ?? 95,
        },
        rpc_public_key: {
            type: overrides.algorithm ?? "ed25519",
            data: overrides.rpcKey ?? OUR_KEY,
        },
        signature: { type: "ed25519", data: "ab12" },
    } as any
}

beforeEach(() => {
    jest.clearAllMocks()
    state.inConsensusLoop = false
    state.lastBlockNumber = 100
    state.lastBlockHash = "hash-100"
    state.shardSize = 4
    state.referenceBlockRoom = 10
    pool = []
    peerMap.clear()
    onlinePeers = []
    lastBlockTxSet = new Set()
    isNextValidator = true
    DTRManager.validityDataCache.clear()
})

describe("broadcastToPool", () => {
    it("delivers to exactly pool - shardSize + 1 validators when all succeed", async () => {
        setupPool(12)
        const results = await DTRManager.broadcastToPool([
            makeValidityData("tx-1"),
        ])

        expect(totalCalls()).toBe(9)
        expect(results.filter(r => r.result === 200)).toHaveLength(9)
        expect(log.warning).not.toHaveBeenCalled()
    })

    it("never broadcasts to the local node", async () => {
        setupPool(12)
        await DTRManager.broadcastToPool([makeValidityData("tx-1")])

        expect(peerMap.get(OUR_KEY).longCall).not.toHaveBeenCalled()
    })

    it("tops up failed deliveries until the coverage target is met", async () => {
        setupPool(12, { failing: 1 })
        const results = await DTRManager.broadcastToPool([
            makeValidityData("tx-1"),
        ])

        expect(results.filter(r => r.result === 200)).toHaveLength(9)
        expect(log.warning).not.toHaveBeenCalled()
    })

    it("exhausts the pool and warns when no validator accepts", async () => {
        setupPool(12, { failing: 11 })
        const results = await DTRManager.broadcastToPool([
            makeValidityData("tx-1"),
        ])

        expect(totalCalls()).toBe(11)
        expect(results.filter(r => r.result === 200)).toHaveLength(0)
        expect(log.warning).toHaveBeenCalledWith(
            expect.stringContaining("0/9"),
        )
    })

    it("warns when unreachable pool members leave coverage short", async () => {
        setupPool(12, { known: 6 })
        await DTRManager.broadcastToPool([makeValidityData("tx-1")])

        expect(totalCalls()).toBe(6)
        expect(log.warning).toHaveBeenCalledWith(
            expect.stringContaining("6/9"),
        )
    })

    it("clamps the coverage target to 1 for tiny pools", async () => {
        setupPool(2)
        const results = await DTRManager.broadcastToPool([
            makeValidityData("tx-1"),
        ])

        expect(totalCalls()).toBe(1)
        expect(results.filter(r => r.result === 200)).toHaveLength(1)
        expect(log.warning).not.toHaveBeenCalled()
    })
})

describe("aggregateConfirmationBlock", () => {
    function makeResponse(
        result: number,
        confirmationBlock?: number,
        opts: { inExtra?: boolean; staged?: boolean } = {},
    ) {
        return {
            result,
            response: opts.inExtra ? {} : { confirmationBlock },
            extra: {
                ...(opts.inExtra ? { confirmationBlock } : {}),
                ...(opts.staged ? { staged: true } : {}),
            },
            require_reply: false,
        } as any
    }

    it("returns the earliest confirmation among accepted responses", () => {
        const results = [
            makeResponse(200, 103),
            makeResponse(200, 101),
            makeResponse(200, 102),
        ]

        expect(DTRManager.aggregateConfirmationBlock(results)).toBe(101)
    })

    it("reads confirmations from extra when absent from the body", () => {
        const results = [makeResponse(200, 102, { inExtra: true })]

        expect(DTRManager.aggregateConfirmationBlock(results)).toBe(102)
    })

    it("ignores rejected responses", () => {
        const results = [
            makeResponse(400, 101),
            makeResponse(500, 101),
            makeResponse(200, 103),
        ]

        expect(DTRManager.aggregateConfirmationBlock(results)).toBe(103)
    })

    it("ignores confirmations at or below the local tip", () => {
        const results = [
            makeResponse(200, 99),
            makeResponse(200, 100),
            makeResponse(200, 102),
        ]

        expect(DTRManager.aggregateConfirmationBlock(results)).toBe(102)
    })

    it("returns null when no usable confirmation exists", () => {
        const results = [
            makeResponse(400, 101),
            makeResponse(200, 90),
            makeResponse(200, undefined),
        ]

        expect(DTRManager.aggregateConfirmationBlock(results)).toBeNull()
    })

    it("prefers staged responses over lower direct-insert confirmations", () => {
        const results = [
            makeResponse(200, 101),
            makeResponse(200, 102, { staged: true }),
            makeResponse(200, 101),
        ]

        expect(DTRManager.aggregateConfirmationBlock(results)).toBe(102)
    })

    it("returns the max among staged responses", () => {
        const results = [
            makeResponse(200, 102, { staged: true }),
            makeResponse(200, 103, { staged: true }),
            makeResponse(200, 101),
        ]

        expect(DTRManager.aggregateConfirmationBlock(results)).toBe(103)
        expect(DTRManager.aggregateStagedConfirmation(results)).toBe(103)
    })

    it("falls back to the direct minimum when staged responses are stale", () => {
        const results = [
            makeResponse(200, 99, { staged: true }),
            makeResponse(200, 102),
        ]

        expect(DTRManager.aggregateStagedConfirmation(results)).toBeNull()
        expect(DTRManager.aggregateConfirmationBlock(results)).toBe(102)
    })
})

describe("stage", () => {
    it("dedups staged transactions by hash", () => {
        const vd = makeValidityData("tx-1")
        DTRManager.stage(vd)
        DTRManager.stage(vd)

        expect(DTRManager.poolSize).toBe(1)
    })

    it("evicts the oldest entry at capacity", () => {
        for (let i = 0; i < 5000; i++) {
            DTRManager.stage(makeValidityData(`tx-${i}`))
        }
        expect(DTRManager.poolSize).toBe(5000)

        DTRManager.stage(makeValidityData("tx-overflow"))

        expect(DTRManager.poolSize).toBe(5000)
        expect(DTRManager.validityDataCache.has("tx-0")).toBe(false)
        expect(DTRManager.validityDataCache.has("tx-overflow")).toBe(true)
    })
})

describe("flushStagedToMempool", () => {
    it("is a no-op while a consensus round is running", async () => {
        DTRManager.stage(makeValidityData("tx-1"))
        state.inConsensusLoop = true

        await DTRManager.flushStagedToMempool()

        expect(Chain.getLastBlockTransactionSet).not.toHaveBeenCalled()
        expect(DTRManager.poolSize).toBe(1)
    })

    it("drops staged transactions already forged in the last block", async () => {
        DTRManager.stage(makeValidityData("tx-1"))
        lastBlockTxSet = new Set(["tx-1"])

        await DTRManager.flushStagedToMempool()

        expect(DTRManager.poolSize).toBe(0)
        expect(Mempool.receive).not.toHaveBeenCalled()
        expect(Mempool.addTransaction).not.toHaveBeenCalled()
    })

    it("drops staged transactions below the deep window cutoff", async () => {
        DTRManager.stage(makeValidityData("tx-old", { reference_block: 40 }))

        await DTRManager.flushStagedToMempool()

        expect(DTRManager.poolSize).toBe(0)
        expect(Mempool.receive).not.toHaveBeenCalled()
        expect(log.warning).toHaveBeenCalledWith(
            expect.stringContaining("deep window cutoff"),
        )
    })

    it("flushes staged transactions and clears the staging area", async () => {
        DTRManager.stage(makeValidityData("tx-1"))
        DTRManager.stage(makeValidityData("tx-2"))

        await DTRManager.flushStagedToMempool()

        expect(Mempool.receive).toHaveBeenCalledTimes(1)
        const received = (Mempool.receive as jest.Mock).mock.calls[0][0]
        expect(received).toHaveLength(2)
        expect(received.map((tx: any) => tx.hash)).toEqual(["tx-1", "tx-2"])
        expect(received[0].blockNumber).toBe(101)
        expect(DTRManager.poolSize).toBe(0)
    })

    it("retains staged transactions when a round starts before the flush lands", async () => {
        DTRManager.stage(makeValidityData("tx-1"))
        DTRManager.stage(makeValidityData("tx-2"))
        ;(Mempool.lock.runExclusive as jest.Mock).mockImplementationOnce(
            async (fn: () => Promise<unknown>) => {
                state.inConsensusLoop = true
                return fn()
            },
        )

        await DTRManager.flushStagedToMempool()

        expect(Mempool.receive).not.toHaveBeenCalled()
        expect(DTRManager.poolSize).toBe(2)
    })

    it("force-flushes while a round is still marked running", async () => {
        DTRManager.stage(makeValidityData("tx-1"))
        DTRManager.stage(makeValidityData("tx-2"))
        state.inConsensusLoop = true

        await DTRManager.flushStagedToMempool(true)

        expect(Mempool.receive).toHaveBeenCalledTimes(1)
        expect(DTRManager.poolSize).toBe(0)
    })

    it("relays flushed transactions when not in the next shard", async () => {
        setupPool(12)
        isNextValidator = false
        DTRManager.stage(makeValidityData("tx-1"))
        DTRManager.stage(makeValidityData("tx-2"))

        await DTRManager.flushStagedToMempool()
        await new Promise(resolve => setImmediate(resolve))

        expect(totalCalls()).toBe(9)
    })

    it("does not relay flushed transactions when in the next shard", async () => {
        setupPool(12)
        isNextValidator = true
        DTRManager.stage(makeValidityData("tx-1"))
        DTRManager.stage(makeValidityData("tx-2"))

        await DTRManager.flushStagedToMempool()
        await new Promise(resolve => setImmediate(resolve))

        expect(totalCalls()).toBe(0)
    })

    it("accepts self-originated validity data on the single-tx path", async () => {
        DTRManager.stage(makeValidityData("tx-1", { rpcKey: OUR_KEY }))
        onlinePeers = []

        await DTRManager.flushStagedToMempool()

        expect(Mempool.addTransaction).toHaveBeenCalledTimes(1)
        expect(
            (Mempool.addTransaction as jest.Mock).mock.calls[0][0].hash,
        ).toBe("tx-1")
        expect(DTRManager.poolSize).toBe(0)
    })
})

describe("receiveRelayedTransactions", () => {
    it("stages mid-round arrivals and parks confirmation two blocks out", async () => {
        state.inConsensusLoop = true

        const res = await DTRManager.receiveRelayedTransactions({
            payload: [makeValidityData("tx-1")],
            blockNumber: 101,
            blockRef: "hash-100",
        })

        expect(res.result).toBe(200)
        expect((res.extra as any).confirmationBlock).toBe(102)
        expect((res.extra as any).lastBlockNumber).toBe(100)
        expect((res.extra as any).staged).toBe(true)
        expect(DTRManager.validityDataCache.has("tx-1")).toBe(true)
    })
})
