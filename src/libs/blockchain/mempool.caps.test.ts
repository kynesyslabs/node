/**
 * The admission caps on the paths that take txs from outside the validator
 * set (RPC submit, gossip ingest): pool count, pool bytes, per-sender pending
 * count and signed-timestamp lifetime, with eviction only for a funded RPC
 * submit. The consensus merge is deliberately not capped. The pool is an
 * in-memory model behind the same data-access methods the SQL backs, so the
 * policy is tested here and the SQL in mempool.capsPg.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test"

const OWN_KEY = "0x" + "aa".repeat(32)
const NOW = 1_800_000_000_000
const DEM = 1_000_000_000n

const quietLog = {
    debug: jest.fn(),
    info: jest.fn(),
    warning: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    only: jest.fn(),
    custom: jest.fn(),
}
const sharedState = {
    lastBlockNumber: 100,
    referenceBlockRoom: 1,
    publicKeyHex: OWN_KEY,
    inConsensusLoop: false,
}
let nonceEnforced = false
const balances = new Map<string, bigint>()
const getAccountBalance = jest.fn(async (addr: string) => balances.get(addr) ?? 0n)

mock.module("src/utilities/logger", () => ({ __esModule: true, default: quietLog }))
mock.module("src/utilities/sharedState", () => ({ getSharedState: sharedState }))
mock.module("@/model/datasource", () => ({
    __esModule: true,
    default: { getInstance: jest.fn() },
}))
mock.module("src/features/metrics/MetricsService", () => ({
    getMetricsService: () => ({
        createCounter: () => undefined,
        incrementCounter: () => undefined,
    }),
}))
mock.module("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: {
        getLastBlockNumber: jest.fn(async () => 100),
        getExistingTransactionHashes: jest.fn(async () => new Set<string>()),
        checkTxExists: jest.fn(async () => false),
        getTransactionFromHash: jest.fn(async () => null),
    },
}))
mock.module("src/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: { getAccountBalance },
}))
// Cuts the import chain that reaches the bridge SDK and its tron dependency.
mock.module("src/libs/network/manageBridge", () => ({
    __esModule: true,
    default: jest.fn(),
}))
const realForks = await import("@/forks")
mock.module("@/forks", () => ({
    ...realForks,
    isForkActive: jest.fn((name: string) => name === "nonceEnforcement" && nonceEnforced),
    pendingTxSignatureContext: jest.fn(() => ({})),
}))
mock.module("src/libs/blockchain/validation/txValidatorPool", () => ({
    __esModule: true,
    default: {
        getInstance: () => ({
            validate: jest.fn(async (txs: Array<{ hash: string }>) =>
                txs.map(t => ({ valid: true, hash: t.hash })),
            ),
        }),
    },
}))
mock.module("src/libs/blockchain/validation/verifyGcrEdits", () => ({
    verifyGcrEditsMatch: jest.fn(async () => ({ match: true })),
    verifyNoUnexplainedValueEdits: jest.fn(async () => ({ ok: true, unexplained: [] })),
}))

let insertedRows: Array<Record<string, unknown>> = []
mock.module("src/libs/blockchain/chainDb", () => ({
    chunkedInsert: jest.fn(
        async (_repo: unknown, _entity: unknown, rows: Array<Record<string, unknown>>) => {
            insertedRows.push(...rows)
            return { inserted: rows.length }
        },
    ),
}))
mock.module("src/libs/consensus/v2/types/secretaryManager", () => ({
    __esModule: true,
    default: class {
        static lastBlockRef = 100
    },
}))

const { default: Mempool } = await import("./mempool")
const { __resetMempoolLimits, __setMempoolLimits, txStoredBytes, txTotalFee } =
    await import("./mempoolLimits")

interface Held {
    hash: string
    tx: Record<string, any>
}

let pool: Held[] = []
let sweeps: Array<{ now: number; force: boolean }> = []
let calls: string[] = []
let nonceOfAccount = 0

const senderOf = (h: Held) => String(h.tx.content.from).toLowerCase()
const tsOf = (h: Held) => Number(h.tx.content.timestamp)

function installPool() {
    const m = Mempool as any
    m.getUsage = async () => ({
        count: pool.length,
        bytes: pool.reduce((n, h) => n + txStoredBytes(h.tx as never), 0),
    })
    m.countPendingBySenders = async (addresses: string[]) => {
        const counts = new Map<string, number>()
        for (const h of pool) {
            if (addresses.includes(senderOf(h))) {
                counts.set(senderOf(h), (counts.get(senderOf(h)) ?? 0) + 1)
            }
        }
        return counts
    }
    m.listEvictionCandidates = async () =>
        pool.map(h => ({
            hash: h.hash,
            timestamp: tsOf(h),
            fee: txTotalFee(h.tx.content.transaction_fee),
            bytes: txStoredBytes(h.tx as never),
        }))
    m.pruneExpiredByAge = async (now: number, force = false) => {
        sweeps.push({ now, force })
        return 0
    }
    m.checkTransactionByHash = async (hash: string) =>
        pool.some(h => h.hash === hash)
    m.getMempoolHashMap = async () =>
        Object.fromEntries(pool.map(h => [h.hash, true]))
    m.getMempool = async () => pool.map(h => h.tx)

    const store = {
        delete: async (where: { hash: unknown }) => {
            calls.push("delete")
            const hashes = (where.hash as { _value: string[] })._value
            pool = pool.filter(h => !hashes.includes(h.hash))
        },
        save: async (row: Record<string, any>) => {
            calls.push("save")
            pool.push({ hash: row.hash, tx: row })
            return { ...row, blockNumber: row.blockNumber }
        },
        exists: async ({ where }: { where: { hash: string } }) =>
            pool.some(h => h.hash === where.hash),
        findOne: async () => ({ nonce: nonceOfAccount }),
    }
    const em = {
        query: async () => undefined,
        getRepository: () => store,
    }
    m.repo = {
        ...store,
        delete: async () => ({ affected: 0 }),
        manager: {
            transaction: async (a: unknown, b?: unknown) => {
                const fn = (typeof a === "function" ? a : b) as (e: unknown) => Promise<unknown>
                calls.push("tx:begin")
                const out = await fn(em)
                calls.push("tx:end")
                return out
            },
        },
    }
}

let seq = 0
function makeTx(over: {
    from?: string
    fee?: number
    ts?: unknown
    pad?: number
    type?: string
    hash?: string
    nonce?: number
}) {
    seq++
    return {
        hash: over.hash ?? `0xh${seq}`,
        status: "pending",
        reference_block: 100,
        blockNumber: 100,
        signature: { type: "ed25519", data: "sig" },
        content: {
            type: over.type ?? "native",
            from: over.from ?? `0xsender${seq}`,
            timestamp: "ts" in over ? over.ts : NOW,
            nonce: over.nonce,
            transaction_fee: {
                network_fee: over.fee ?? 1,
                rpc_fee: 0,
                additional_fee: 0,
            },
            pad: "x".repeat(over.pad ?? 0),
        },
    } as any
}

const fund = (addr: string, dem: number) => balances.set(addr.toLowerCase(), BigInt(dem) * DEM)

beforeEach(() => {
    pool = []
    sweeps = []
    calls = []
    insertedRows = []
    seq = 0
    nonceEnforced = false
    nonceOfAccount = 0
    sharedState.inConsensusLoop = false
    balances.clear()
    getAccountBalance.mockClear()
    jest.spyOn(Date, "now").mockImplementation(() => NOW)
    installPool()
})

afterEach(() => {
    __resetMempoolLimits()
    jest.restoreAllMocks()
})

const rpc = (tx: any) => Mempool.addTransactionWithLock(tx, undefined, { origin: "rpc" })
const gossip = (tx: any) => Mempool.addTransactionWithLock(tx, undefined, { origin: "gossip" })
const internal = (tx: any) => Mempool.addTransactionWithLock(tx)

describe("pool count cap", () => {
    it("refuses a tx once the pool is full and names the cap", async () => {
        __setMempoolLimits({ maxTxs: 3 })
        for (let i = 0; i < 3; i++) {
            expect((await rpc(makeTx({ from: `0xs${i}` }))).error).toBe("")
        }
        fund("0xlate", 100)
        const refused = await rpc(makeTx({ from: "0xlate" }))
        expect(refused.confirmationBlock).toBeNull()
        expect(refused.error).toMatch(/Mempool full \(3 transactions\)/)
        expect(pool).toHaveLength(3)
    })
})

describe("eviction", () => {
    beforeEach(async () => {
        __setMempoolLimits({ maxTxs: 3 })
        await rpc(makeTx({ hash: "0xhigh", fee: 9, ts: NOW - 1000 }))
        await rpc(makeTx({ hash: "0xlow-new", fee: 1, ts: NOW - 10 }))
        await rpc(makeTx({ hash: "0xlow-old", fee: 1, ts: NOW - 500 }))
    })

    it("makes room for a funded higher-paying RPC tx by dropping the lowest fee, oldest first", async () => {
        fund("0xpayer", 10)
        expect((await rpc(makeTx({ hash: "0xpays", fee: 5, from: "0xpayer" }))).error).toBe("")
        expect(pool.map(h => h.hash).sort()).toEqual(["0xhigh", "0xlow-new", "0xpays"])

        expect((await rpc(makeTx({ hash: "0xmore", fee: 6, from: "0xpayer" }))).error).toBe("")
        expect(pool.map(h => h.hash).sort()).toEqual(["0xhigh", "0xmore", "0xpays"])
    })

    it("deletes the victims inside the database transaction that inserts, after the checks", async () => {
        fund("0xpayer", 10)
        calls = []
        await rpc(makeTx({ hash: "0xpays", fee: 5, from: "0xpayer" }))
        expect(calls).toEqual(["tx:begin", "delete", "save", "tx:end"])
    })

    it("does not evict for a high fee the sender cannot pay", async () => {
        fund("0xbroke", 1)
        const refused = await rpc(makeTx({ hash: "0xunfunded", fee: 50, from: "0xbroke" }))
        expect(refused.error).toMatch(/sender balance does not cover the transaction fee/)
        expect(pool).toHaveLength(3)
        expect(pool.map(h => h.hash).sort()).toEqual(["0xhigh", "0xlow-new", "0xlow-old"])
    })

    it("reads the sender balance once, and only because the pool is full", async () => {
        getAccountBalance.mockClear()
        fund("0xpayer", 10)
        await rpc(makeTx({ fee: 5, from: "0xpayer" }))
        expect(getAccountBalance).toHaveBeenCalledTimes(1)

        __setMempoolLimits({ maxTxs: 100 })
        getAccountBalance.mockClear()
        await rpc(makeTx({ fee: 5, from: "0xpayer" }))
        expect(getAccountBalance).not.toHaveBeenCalled()
    })

    it("does not evict when the tx then fails its nonce check", async () => {
        nonceEnforced = true
        nonceOfAccount = 10
        fund("0xpayer", 10)
        const failed = await rpc(makeTx({ hash: "0xstale-nonce", fee: 5, from: "0xpayer", nonce: 3 }))
        expect(failed.error).toMatch(/Invalid nonce/)
        expect(pool.map(h => h.hash).sort()).toEqual(["0xhigh", "0xlow-new", "0xlow-old"])
        expect(calls).not.toContain("delete")
    })

    it("does not evict when the tx is already in the pool", async () => {
        fund("0xpayer", 10)
        const dup = await rpc(makeTx({ hash: "0xhigh", fee: 5, from: "0xpayer" }))
        expect(dup.error).toMatch(/already in mempool/)
        expect(pool).toHaveLength(3)
    })

    it("turns a tx away at equal fees instead of displacing waiting ones", async () => {
        fund("0xpayer", 10)
        const refused = await rpc(makeTx({ fee: 1, from: "0xpayer" }))
        expect(refused.error).toMatch(/Mempool full/)
        expect(pool).toHaveLength(3)
    })

    it("does not evict while a consensus round is in progress", async () => {
        sharedState.inConsensusLoop = true
        fund("0xpayer", 100)
        const refused = await rpc(makeTx({ fee: 50, from: "0xpayer" }))
        expect(refused.error).toMatch(/Mempool full/)
        expect(pool.map(h => h.hash).sort()).toEqual(["0xhigh", "0xlow-new", "0xlow-old"])
        expect(calls).not.toContain("delete")
    })

    it("does not delete when a round starts after the admission check", async () => {
        fund("0xpayer", 100)
        const m = Mempool as any
        const candidates = m.listEvictionCandidates
        m.listEvictionCandidates = async () => {
            const rows = await candidates()
            sharedState.inConsensusLoop = true
            return rows
        }
        const refused = await rpc(makeTx({ fee: 50, from: "0xpayer" }))
        expect(refused.error).toMatch(/Mempool full/)
        expect(pool).toHaveLength(3)
        expect(calls).not.toContain("delete")

        nonceEnforced = true
        sharedState.inConsensusLoop = false
        const refusedWithNonce = await rpc(makeTx({ fee: 50, from: "0xpayer", nonce: 3 }))
        expect(refusedWithNonce.error).toMatch(/Mempool full/)
        expect(pool).toHaveLength(3)
        expect(calls).not.toContain("delete")
    })

    it("never evicts for a gossiped or internal tx, whatever it pays", async () => {
        fund("0xpayer", 100)
        expect((await gossip(makeTx({ fee: 50, from: "0xpayer" }))).error).toMatch(/Mempool full/)
        expect((await internal(makeTx({ fee: 50, from: "0xpayer" }))).error).toMatch(/Mempool full/)
        expect(pool).toHaveLength(3)
        expect(getAccountBalance).not.toHaveBeenCalled()
    })
})

describe("pool byte cap", () => {
    it("refuses a tx that would push the pool past the byte cap", async () => {
        const one = txStoredBytes(makeTx({ pad: 1000 }))
        __setMempoolLimits({ maxBytes: one * 2 + 10 })
        expect((await rpc(makeTx({ pad: 1000 }))).error).toBe("")
        expect((await rpc(makeTx({ pad: 1000 }))).error).toBe("")
        fund("0xlate", 100)
        const refused = await rpc(makeTx({ pad: 1000, from: "0xlate" }))
        expect(refused.error).toMatch(/Mempool full \(\d+ MiB of transactions\)/)
        expect(pool).toHaveLength(2)
    })

    it("evicts several small cheap txs to fit one large funded RPC tx that pays more", async () => {
        const small = txStoredBytes(makeTx({ pad: 100 }))
        const base = txStoredBytes(makeTx({ pad: 0 }))
        const big = makeTx({ hash: "0xbig", fee: 8, from: "0xpayer", pad: Math.round(small * 2.2 - base) })
        __setMempoolLimits({ maxBytes: small * 5 })
        for (let i = 0; i < 5; i++) {
            await rpc(makeTx({ hash: `0xs${i}`, fee: 1, ts: NOW - 100 + i, pad: 100 }))
        }
        fund("0xpayer", 10)
        expect((await rpc(big)).error).toBe("")
        expect(pool.map(h => h.hash).sort()).toEqual(["0xbig", "0xs3", "0xs4"])
    })
})

describe("per-sender cap", () => {
    it("refuses a sender's tx past the cap and still serves other senders", async () => {
        __setMempoolLimits({ maxPerSender: 2 })
        await rpc(makeTx({ from: "0xAlice" }))
        await gossip(makeTx({ from: "0xalice" }))
        const refused = await rpc(makeTx({ from: "0xALICE" }))
        expect(refused.error).toMatch(/Too many pending transactions from this sender \(limit 2\)/)
        expect((await rpc(makeTx({ from: "0xbob" }))).error).toBe("")
    })

    it("does not apply the sender cap to the node's own identity", async () => {
        __setMempoolLimits({ maxPerSender: 1 })
        expect((await internal(makeTx({ from: OWN_KEY }))).error).toBe("")
        expect((await internal(makeTx({ from: OWN_KEY }))).error).toBe("")
    })
})

describe("lifetime", () => {
    it("refuses a tx signed longer ago than the lifetime", async () => {
        const refused = await rpc(makeTx({ ts: NOW - 10 * 60 * 1000 - 1 }))
        expect(refused.error).toMatch(/Transaction expired: signed more than 600s ago/)
        expect(pool).toHaveLength(0)
    })

    it("refuses a timestamp too far in the future", async () => {
        const refused = await rpc(makeTx({ ts: NOW + 5 * 60 * 1000 + 1 }))
        expect(refused.error).toMatch(/ahead of the node clock/)
    })

    it("refuses a missing, fractional or non-numeric timestamp with a clear reason", async () => {
        for (const ts of [undefined, 1.5, "1800000000000", 0, -5]) {
            const refused = await gossip(makeTx({ ts }))
            expect(refused.error).toMatch(/positive whole number of milliseconds/)
        }
        expect(pool).toHaveLength(0)
    })
})

describe("expiry sweep", () => {
    it("runs from admission when no consensus round is in progress", async () => {
        await rpc(makeTx({}))
        expect(sweeps).toEqual([{ now: NOW, force: false }])
    })

    it("does not run from admission during a consensus round", async () => {
        sharedState.inConsensusLoop = true
        await rpc(makeTx({}))
        await gossip(makeTx({}))
        expect(sweeps).toEqual([])
    })

    it("runs after a block whatever the consensus state", async () => {
        sharedState.inConsensusLoop = true
        await Mempool.pruneAfterBlock(101, [])
        expect(sweeps).toEqual([{ now: NOW, force: true }])
    })
})

describe("node's own relay txs", () => {
    // The aggregator stamps a network clock in seconds, so the lifetime and
    // the caps must not apply to it.
    const relay = (over = {}) =>
        makeTx({ from: OWN_KEY, type: "l2psBatch", fee: 0, ts: Math.floor(NOW / 1000), ...over })

    it("admits an own l2psBatch tx, seconds timestamp and all, into a full pool", async () => {
        __setMempoolLimits({ maxTxs: 1 })
        await rpc(makeTx({ fee: 9 }))
        expect((await internal(relay())).error).toBe("")
        expect(pool).toHaveLength(2)
    })

    it("does not give that exemption to someone else's tx labelled l2psBatch", async () => {
        __setMempoolLimits({ maxTxs: 1 })
        await rpc(makeTx({ fee: 9 }))
        const other = makeTx({ type: "l2psBatch", fee: 0 })
        expect((await internal(other)).error).toMatch(/Mempool full/)
        const old = makeTx({ type: "l2psBatch", ts: Math.floor(NOW / 1000) })
        expect((await internal(old)).error).toMatch(/Transaction expired/)
    })
})

describe("peer merge (receive)", () => {
    it("is not capped: every member must end the merge with the same pool", async () => {
        __setMempoolLimits({ maxTxs: 1, maxPerSender: 1, maxBytes: 1 })
        const res = await Mempool.receive([
            makeTx({ hash: "0x1", from: "0xspam" }),
            makeTx({ hash: "0x2", from: "0xspam" }),
            makeTx({ hash: "0x3", from: "0xspam" }),
        ])
        expect(res.success).toBe(true)
        expect(insertedRows.map(r => r.hash)).toEqual(["0x1", "0x2", "0x3"])
    })

    it("does not apply the tx lifetime", async () => {
        await Mempool.receive([
            makeTx({ hash: "0xold", ts: NOW - 11 * 60 * 1000 }),
            makeTx({ hash: "0xfuture", ts: NOW + 60 * 60 * 1000 }),
        ])
        expect(insertedRows.map(r => r.hash)).toEqual(["0xold", "0xfuture"])
    })

    it("does not evict or sweep", async () => {
        __setMempoolLimits({ maxTxs: 1 })
        await rpc(makeTx({ hash: "0xheld", fee: 1 }))
        sweeps = []
        await Mempool.receive([makeTx({ hash: "0xm", fee: 9 })])
        expect(pool.map(h => h.hash)).toEqual(["0xheld"])
        expect(sweeps).toEqual([])
        expect(calls).not.toContain("delete")
    })
})
