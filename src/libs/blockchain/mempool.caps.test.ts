/**
 * The admission caps on the paths that take txs from outside the validator
 * set (RPC submit, gossip ingest): pool count, pool bytes, per-sender pending
 * count and signed-timestamp lifetime, with eviction only for a funded RPC
 * submit or gossiped tx, gossip at most one try a second. The consensus
 * merge is deliberately not capped. The pool is an in-memory model behind
 * the same data-access methods the SQL backs, so the policy is tested here
 * and the SQL in mempool.capsPg.test.ts.
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
    publicKeyHex: OWN_KEY,
    inConsensusLoop: false,
}
let nonceEnforced = false
let nftGated = false
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
    isForkActive: jest.fn(
        (name: string) =>
            (name === "nonceEnforcement" && nonceEnforced) || (name === "nftValidatorGating" && nftGated),
    ),
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

// Spread the real module so exports other mempool dependencies import from it
// keep resolving; only the two checks the caps policy bypasses are stubbed.
// Loaded after the mocks above so its own imports see them.
const realVerifyGcrEdits = await import("src/libs/blockchain/validation/verifyGcrEdits")
mock.module("src/libs/blockchain/validation/verifyGcrEdits", () => ({
    ...realVerifyGcrEdits,
    verifyGcrEditsMatch: jest.fn(async () => ({ match: true })),
    verifyNoUnexplainedValueEdits: jest.fn(async () => ({ ok: true, unexplained: [] })),
}))

let blockCapsOn = false
mock.module("@/forks/blockCapsGate", () => ({
    blockCapsActive: () => blockCapsOn,
    blockCapsActiveForPendingBlock: () => blockCapsOn,
}))

const { default: Mempool } = await import("./mempool")
const { __resetMempoolLimits, __setMempoolLimits, chooseVictims, txStoredBytes, txTotalFee } =
    await import("./mempoolLimits")
const { __clearDroppedTxs: clearDroppedTxs, getDroppedTx } = await import("./droppedTransactions")
const { default: chain } = await import("src/libs/blockchain/chain")
// installPool replaces the sweep; the dropped-record tests run the real one.
const realPruneExpiredByAge = Mempool.pruneExpiredByAge

// What each bulk delete (query builder) returns, keyed by a column its WHERE names.
let deletedBy: Record<string, string[]> = {}
const queryBuilder = () => {
    let where = ""
    const qb: Record<string, unknown> = {}
    for (const step of ["delete", "from", "returning"]) qb[step] = () => qb
    qb.where = (sql: string) => {
        where = sql
        return qb
    }
    qb.execute = async () => {
        const key = Object.keys(deletedBy).find(column => where.includes(column))
        const rows = (key ? deletedBy[key] : []).map(hash => ({ hash }))
        return { raw: rows, affected: rows.length }
    }
    return qb
}

interface Held {
    hash: string
    tx: Record<string, any>
}

let pool: Held[] = []
let sweeps: Array<{ now: number; force: boolean }> = []
let calls: string[] = []
let nonceOfAccount = 0
let clock = NOW

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
    m.listPendingBySenders = async (addresses: string[]) =>
        pool
            .filter(h => addresses.map(a => a.toLowerCase()).includes(senderOf(h)))
            .map(h => ({ hash: h.hash, sender: senderOf(h), nonce: h.tx.content.nonce, type: h.tx.content.type }))
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
        createQueryBuilder: queryBuilder,
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
    blockCapsOn = false
    nonceOfAccount = 0
    sharedState.inConsensusLoop = false
    nftGated = false
    balances.clear()
    getAccountBalance.mockClear()
    clock = NOW
    jest.spyOn(Date, "now").mockImplementation(() => clock)
    ;(Mempool as any).lastGossipEvictAttempt = 0
    deletedBy = {}
    clearDroppedTxs()
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

    it("records each victim as dropped, not final, on both insert paths", async () => {
        fund("0xpayer", 10)
        expect((await rpc(makeTx({ hash: "0xpays", fee: 5, from: "0xpayer" }))).error).toBe("")
        expect(getDroppedTx("0xlow-old")).toMatchObject({ reason: "evicted_fee", final: false, droppedAtBlock: 100 })

        nonceEnforced = true
        expect((await rpc(makeTx({ hash: "0xmore", fee: 6, from: "0xpayer", nonce: 1 }))).error).toBe("")
        expect(getDroppedTx("0xlow-new")).toMatchObject({ reason: "evicted_fee", final: false })
        expect(getDroppedTx("0xhigh")).toBeNull()
    })

    it("records no victim when the tx is not inserted after all", async () => {
        nonceEnforced = true
        nonceOfAccount = 10
        fund("0xpayer", 100)
        expect((await rpc(makeTx({ fee: 50, from: "0xpayer", nonce: 3 }))).error).toMatch(/Invalid nonce/)
        const m = Mempool as any
        const candidates = m.listEvictionCandidates
        m.listEvictionCandidates = async () => {
            const rows = await candidates()
            sharedState.inConsensusLoop = true
            return rows
        }
        expect((await rpc(makeTx({ fee: 50, from: "0xpayer", nonce: 11 }))).error).toMatch(/Mempool full/)
        for (const hash of ["0xhigh", "0xlow-new", "0xlow-old"]) expect(getDroppedTx(hash)).toBeNull()
    })

    it("records no victim when the database transaction that evicts fails to commit", async () => {
        nonceEnforced = true
        fund("0xpayer", 10)
        const manager = (Mempool as any).repo.manager
        const transaction = manager.transaction
        manager.transaction = async (...args: unknown[]) => {
            await transaction(...args)
            throw new Error("commit failed")
        }
        calls = []
        const refused = await rpc(makeTx({ hash: "0xpays", fee: 5, from: "0xpayer", nonce: 1 }))
        expect(calls).toEqual(["tx:begin", "delete", "save", "tx:end"])
        expect(refused).toEqual({ confirmationBlock: null, error: "Error: Failed to add transaction to mempool" })
        expect(getDroppedTx("0xlow-old")).toBeNull()
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

    // A peer that refused what the RPC node admitted would leave the tx to
    // land only while that node sits in the committee.
    it("makes room for a funded higher-paying gossiped tx as it does for RPC", async () => {
        fund("0xpayer", 10)
        expect((await gossip(makeTx({ hash: "0xpays", fee: 5, from: "0xpayer" }))).error).toBe("")
        expect(pool.map(h => h.hash).sort()).toEqual(["0xhigh", "0xlow-new", "0xpays"])
    })

    it("deletes a gossiped tx's victims inside the database transaction that inserts", async () => {
        fund("0xpayer", 10)
        calls = []
        expect((await gossip(makeTx({ hash: "0xpays", fee: 5, from: "0xpayer" }))).error).toBe("")
        expect(calls).toEqual(["tx:begin", "delete", "save", "tx:end"])
    })

    it("holds a gossiped tx to the same refusals at a full pool as an RPC one", async () => {
        fund("0xbroke", 1)
        expect((await gossip(makeTx({ fee: 50, from: "0xbroke" }))).error).toMatch(
            /sender balance does not cover the transaction fee/,
        )
        fund("0xpayer", 100)
        clock = NOW + 1000
        expect((await gossip(makeTx({ fee: 1, from: "0xpayer" }))).error).toMatch(/Mempool full/)
        clock = NOW + 2000
        sharedState.inConsensusLoop = true
        expect((await gossip(makeTx({ fee: 50, from: "0xpayer" }))).error).toMatch(/Mempool full/)
        expect(pool.map(h => h.hash).sort()).toEqual(["0xhigh", "0xlow-new", "0xlow-old"])
        expect(calls).not.toContain("delete")
    })

    it("never evicts for an internal tx, whatever it pays", async () => {
        fund("0xpayer", 100)
        expect((await internal(makeTx({ fee: 50, from: "0xpayer" }))).error).toMatch(/Mempool full/)
        expect(pool).toHaveLength(3)
        expect(getAccountBalance).not.toHaveBeenCalled()
    })

    // A try reads every held tx under the mempool lock, and gossip brings
    // every peer's submissions, so it gets one try a second.
    describe("gossip eviction interval", () => {
        it("refuses a second gossiped tx inside the interval as full, without reading the pool", async () => {
            const scans = jest.spyOn(Mempool as any, "listEvictionCandidates")
            fund("0xpayer", 100)
            expect((await gossip(makeTx({ hash: "0xfirst", fee: 5, from: "0xpayer" }))).error).toBe("")
            expect(scans).toHaveBeenCalledTimes(1)

            clock = NOW + 999
            getAccountBalance.mockClear()
            const refused = await gossip(makeTx({ hash: "0xsecond", fee: 50, from: "0xpayer" }))
            expect(refused.error).toMatch(/Mempool full \(3 transactions\)/)
            expect(scans).toHaveBeenCalledTimes(1)
            expect(getAccountBalance).not.toHaveBeenCalled()
            expect(pool.map(h => h.hash).sort()).toEqual(["0xfirst", "0xhigh", "0xlow-new"])
        })

        it("counts a try refused at the balance read, and lets the next one try after the interval", async () => {
            const scans = jest.spyOn(Mempool as any, "listEvictionCandidates")
            fund("0xbroke", 1)
            fund("0xpayer", 100)
            expect((await gossip(makeTx({ fee: 50, from: "0xbroke" }))).error).toMatch(
                /sender balance does not cover the transaction fee/,
            )
            expect(scans).not.toHaveBeenCalled()

            clock = NOW + 500
            getAccountBalance.mockClear()
            expect((await gossip(makeTx({ fee: 50, from: "0xpayer" }))).error).toMatch(
                /Mempool full \(3 transactions\)/,
            )
            expect(getAccountBalance).not.toHaveBeenCalled()
            expect(scans).not.toHaveBeenCalled()

            clock = NOW + 1000
            expect((await gossip(makeTx({ hash: "0xlater", fee: 50, from: "0xpayer" }))).error).toBe("")
            expect(scans).toHaveBeenCalledTimes(1)
            expect(pool.map(h => h.hash).sort()).toEqual(["0xhigh", "0xlater", "0xlow-new"])
        })

        // NTP or an operator can step the host clock back past the last try;
        // gossip eviction must not stop until the clock catches up.
        it("lets a gossiped tx try when the clock has stepped back behind the last try", async () => {
            const scans = jest.spyOn(Mempool as any, "listEvictionCandidates")
            fund("0xpayer", 100)
            expect((await gossip(makeTx({ hash: "0xfirst", fee: 5, from: "0xpayer" }))).error).toBe("")
            expect(scans).toHaveBeenCalledTimes(1)

            clock = NOW - 30_000
            expect((await gossip(makeTx({ hash: "0xback", fee: 50, from: "0xpayer" }))).error).toBe("")
            expect(scans).toHaveBeenCalledTimes(2)
            expect(pool.map(h => h.hash).sort()).toEqual(["0xback", "0xfirst", "0xhigh"])
        })

        // On a slow database the queries before the gate take a while; the
        // slot is stamped when a try reaches the gate, so two scans cannot
        // start less than the interval apart.
        it("stamps the try when it reaches the gate, not when admission started", async () => {
            const scans = jest.spyOn(Mempool as any, "listEvictionCandidates")
            const m = Mempool as any
            const usage = m.getUsage
            let dbDelay = 1200
            m.getUsage = async () => {
                const u = await usage()
                clock += dbDelay
                return u
            }
            fund("0xpayer", 100)
            expect((await gossip(makeTx({ hash: "0xslow", fee: 5, from: "0xpayer" }))).error).toBe("")
            expect(m.lastGossipEvictAttempt).toBe(NOW + 1200)
            expect(scans).toHaveBeenCalledTimes(1)

            clock = NOW + 1500
            dbDelay = 100
            getAccountBalance.mockClear()
            const refused = await gossip(makeTx({ hash: "0xclose", fee: 50, from: "0xpayer" }))
            expect(refused.error).toMatch(/Mempool full \(3 transactions\)/)
            expect(scans).toHaveBeenCalledTimes(1)
            expect(getAccountBalance).not.toHaveBeenCalled()
            expect(m.lastGossipEvictAttempt).toBe(NOW + 1200)
            expect(pool.map(h => h.hash).sort()).toEqual(["0xhigh", "0xlow-new", "0xslow"])
        })

        it("neither limits RPC submits nor counts them against gossip", async () => {
            const scans = jest.spyOn(Mempool as any, "listEvictionCandidates")
            fund("0xpayer", 100)
            expect((await rpc(makeTx({ hash: "0xrpc1", fee: 5, from: "0xpayer" }))).error).toBe("")
            expect((await gossip(makeTx({ hash: "0xgossip", fee: 6, from: "0xpayer" }))).error).toBe("")
            expect((await rpc(makeTx({ hash: "0xrpc2", fee: 7, from: "0xpayer" }))).error).toBe("")
            expect(scans).toHaveBeenCalledTimes(3)
            expect(pool.map(h => h.hash).sort()).toEqual(["0xgossip", "0xhigh", "0xrpc2"])
        })
    })
})

// Past 2^53 a JSON number fee is no longer exact in JS, while Postgres keeps
// its stored digits: 300000000000000500 DEM reads as 300000000000000512 DEM
// here and stays 300000000000000500 DEM there. Admission must rank held txs
// the one way chooseVictims does, or it turns away a tx that outbids the
// cheapest of them.
describe("eviction among fees past 2^53", () => {
    const withFee = (tx: any, networkFee: unknown) => {
        tx.content.transaction_fee = { network_fee: networkFee, rpc_fee: 0, additional_fee: 0 }
        return tx
    }

    beforeEach(async () => {
        __setMempoolLimits({ maxTxs: 2 })
        await rpc(withFee(makeTx({ hash: "0xnumber" }), Number("300000000000000500")))
        await rpc(withFee(makeTx({ hash: "0xstring" }), "300000000000000500000000001"))
        expect(pool).toHaveLength(2)
    })

    for (const [name, submit] of [
        ["gossiped", gossip],
        ["RPC", rpc],
    ] as const) {
        it(`admits a funded ${name} tx by evicting the tx chooseVictims ranks cheapest`, async () => {
            balances.set("0xpayer", 10n ** 30n)
            const incoming = withFee(makeTx({ hash: "0xpays", from: "0xpayer" }), "300000000000000500000000002")
            const victims = chooseVictims(
                await (Mempool as any).listEvictionCandidates(),
                { fee: txTotalFee(incoming.content.transaction_fee), bytes: txStoredBytes(incoming) },
                await (Mempool as any).getUsage(),
            )
            expect(victims?.map(v => v.hash)).toEqual(["0xstring"])

            expect((await submit(incoming)).error).toBe("")
            expect(pool.map(h => h.hash).sort()).toEqual(["0xnumber", "0xpays"])
        })
    }
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

// #973: what leaves the pool without a block taking it is recorded, so the
// status call answers "dropped" instead of "unknown".
describe("dropped record of the sweeps", () => {
    it("records what a block's hygiene removes for its reference block or its age, and not the block's own txs", async () => {
        (Mempool as any).pruneExpiredByAge = realPruneExpiredByAge
        deletedBy = { reference_block: ["0xold-ref"], timestamp: ["0xstale"] }
        const pruned = await Mempool.pruneAfterBlock(101, ["0xincluded"])
        expect(pruned.expired).toBe(2)
        expect(getDroppedTx("0xold-ref")).toMatchObject({
            reason: "reference_block_expired",
            final: false,
            droppedAtBlock: 101,
        })
        expect(getDroppedTx("0xstale")).toMatchObject({ reason: "expired", final: false })
        expect(getDroppedTx("0xincluded")).toBeNull()
    })

    it("records what the admission sweep removes for its age", async () => {
        (Mempool as any).pruneExpiredByAge = realPruneExpiredByAge
        ;(Mempool as any).lastAgeSweep = 0
        deletedBy = { timestamp: ["0xstale"] }
        expect(await Mempool.pruneExpiredByAge(NOW)).toBe(1)
        expect(getDroppedTx("0xstale")).toMatchObject({ reason: "expired", final: false, droppedAtBlock: 100 })
    })

    it("records the stale txs cleanMempool removes, and not those already on chain", async () => {
        const m = Mempool as any
        m.repo.find = async () => [
            { hash: "0xstale-ref", reference_block: 10 },
            { hash: "0xexecuted", reference_block: 100 },
            { hash: "0xlive", reference_block: 100 },
        ]
        ;(chain.getExistingTransactionHashes as any).mockResolvedValueOnce(new Set(["0xexecuted"]))
        expect(await Mempool.cleanMempool()).toEqual({ staleRemoved: 1, executedRemoved: 1 })
        expect(getDroppedTx("0xstale-ref")).toMatchObject({ reason: "reference_block_expired", droppedAtBlock: 100 })
        expect(getDroppedTx("0xexecuted")).toBeNull()
        expect(getDroppedTx("0xlive")).toBeNull()
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

describe("block caps", () => {
    // Over an empty block's byte cap: no block can take it, and while it
    // waits every later nonce of its sender waits too.
    const oversize = () => makeTx({ pad: 4 * 1024 * 1024 + 1 })

    it("refuses a tx no block can take, from every origin", async () => {
        blockCapsOn = true
        __setMempoolLimits({ maxBytes: 64 * 1024 * 1024 })
        for (const submit of [rpc, gossip, internal]) {
            const { error } = await submit(oversize())
            expect(error).toContain("no block can take it")
        }
        expect(pool).toHaveLength(0)
    })

    it("admits a tx that fits an empty block", async () => {
        blockCapsOn = true
        expect((await rpc(makeTx({ pad: 1024 }))).error).toBe("")
    })

    it("admits the oversize tx before the fork", async () => {
        __setMempoolLimits({ maxBytes: 64 * 1024 * 1024 })
        expect((await rpc(oversize())).error).toBe("")
    })
})

describe("seat transactions per sender under nftValidatorGating", () => {
    const gate = () => {
        nftGated = true
    }
    const seatTx = (type: string) => makeTx({ from: "0xSeat", type, fee: 0 })

    it("holds at most two stakes and challenges of one sender, on every intake path", async () => {
        gate()
        expect((await rpc(seatTx("validatorStake"))).error).toBe("")
        expect((await gossip(seatTx("validatorChallenge"))).error).toBe("")
        for (const add of [rpc, gossip, internal]) {
            const out = await add(seatTx("validatorChallenge"))
            expect(out.error).toBe("Sender already holds 2 seat transactions in the pool (at most 2)")
        }
        expect(pool).toHaveLength(2)
    })

    it("does not count other transactions of the sender, nor limit their own types", async () => {
        gate()
        fund("0xseat", 100)
        await rpc(seatTx("validatorStake"))
        expect((await rpc(makeTx({ from: "0xseat" }))).error).toBe("")
        expect((await rpc(seatTx("validatorUnstake"))).error).toBe("")
        expect((await rpc(seatTx("validatorChallenge"))).error).toBe("")
        expect((await rpc(makeTx({ from: "0xseat" }))).error).toBe("")
    })

    it("leaves the pool alone before the fork", async () => {
        for (let i = 0; i < 3; i++) expect((await rpc(seatTx("validatorStake"))).error).toBe("")
    })
})
