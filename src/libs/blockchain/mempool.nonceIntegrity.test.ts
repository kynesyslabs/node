/**
 * Nonce admission under `nonceIntegrity`. A tx is admitted when its nonce is
 * above the sender's confirmed one, no more than MEMPOOL_MAX_NONCE_AHEAD past
 * it, and not already held by another pending tx of the same sender. Gaps
 * inside the window are allowed: a batch sent through several RPCs arrives
 * out of order. The pool is an in-memory model behind the data-access methods
 * the SQL backs; the transactions are built and signed by the real SDK.
 */

import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test"

const OWN_KEY = "0x" + "aa".repeat(32)

const quietLog = {
    debug: jest.fn(),
    info: jest.fn(),
    warning: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    only: jest.fn(),
    custom: jest.fn(),
}
const sharedState: Record<string, unknown> = {
    lastBlockNumber: 100,
    referenceBlockRoom: 1,
    publicKeyHex: OWN_KEY,
    inConsensusLoop: false,
}
let nonceIntegrity = true

mock.module("src/utilities/logger", () => ({ __esModule: true, default: quietLog }))
mock.module("src/utilities/sharedState", () => ({ getSharedState: sharedState }))
mock.module("@/utilities/sharedState", () => ({ getSharedState: sharedState }))
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
    default: { getAccountBalance: jest.fn(async () => 0n) },
}))
mock.module("src/libs/network/manageBridge", () => ({
    __esModule: true,
    default: jest.fn(),
}))
const realForks = await import("@/forks")
mock.module("@/forks", () => ({
    ...realForks,
    isForkActive: jest.fn(
        (name: string) => name === "nonceEnforcement" || (name === "nonceIntegrity" && nonceIntegrity),
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
mock.module("src/libs/consensus/v2/types/secretaryManager", () => ({
    __esModule: true,
    default: class {
        static lastBlockRef = 100
    },
}))

const { DemosTransactions } = await import("@kynesyslabs/demosdk/websdk")
const { PEER, SENDER, demos, onTheWire, OS } = await import("@/libs/blockchain/validation/editBinding.fixtures")
const { default: Mempool } = await import("./mempool")
const { MEMPOOL_MAX_NONCE_AHEAD } = await import("@/utilities/constants")

interface Held {
    hash: string
    tx: Record<string, any>
}

let pool: Held[] = []
let confirmedNonce = 7
let lockedOn: string[] = []
let accountLookups: unknown[] = []
const originalNonce = demos.getAddressNonce

const nonceAccountOf = (h: Held) =>
    String(h.tx.content.from_ed25519_address || h.tx.content.from).toLowerCase()

function installPool() {
    const m = Mempool as any
    m.getUsage = async () => ({ count: pool.length, bytes: 0 })
    m.countPendingBySenders = async () => new Map<string, number>()
    m.listEvictionCandidates = async () => []
    m.pruneExpiredByAge = async () => 0
    m.checkTransactionByHash = async (hash: string) => pool.some(h => h.hash === hash)

    const store = {
        save: async (row: Record<string, any>) => {
            pool.push({ hash: row.hash, tx: row })
            return { ...row }
        },
        delete: async () => ({ affected: 0 }),
        exists: async ({ where }: { where: { hash: string } }) =>
            pool.some(h => h.hash === where.hash),
        findOne: async (q: unknown) => {
            accountLookups.push(q)
            return { nonce: confirmedNonce }
        },
        createQueryBuilder: () => {
            const params: Record<string, unknown> = {}
            const builder = {
                where: (_sql: string, p: Record<string, unknown>) => (Object.assign(params, p), builder),
                andWhere: (_sql: string, p: Record<string, unknown>) => (Object.assign(params, p), builder),
                getCount: async () =>
                    pool.filter(h => nonceAccountOf(h) === params.account && Number(h.tx.nonce) === params.nonce)
                        .length,
            }
            return builder
        },
    }
    const em = {
        query: async (_sql: string, args: string[]) => {
            lockedOn.push(args[0])
        },
        getRepository: () => store,
    }
    m.repo = {
        ...store,
        manager: {
            transaction: async (a: unknown, b?: unknown) => {
                const fn = (typeof a === "function" ? a : b) as (e: unknown) => Promise<unknown>
                return await fn(em)
            },
        },
    }
}

/** A native transfer SENDER signed with `nonce`, as the node receives it. */
async function signed(nonce: number, amount = 3n): Promise<any> {
    demos.getAddressNonce = async () => nonce - 1
    try {
        const tx = onTheWire(await DemosTransactions.pay(PEER, amount * OS, demos)) as any
        tx.reference_block = 100
        return tx
    } finally {
        demos.getAddressNonce = originalNonce
    }
}

const rpc = (tx: any) => Mempool.addTransactionWithLock(tx, undefined, { origin: "rpc" })
const gossip = (tx: any) => Mempool.addTransactionWithLock(tx, undefined, { origin: "gossip" })

beforeEach(() => {
    pool = []
    confirmedNonce = 7
    lockedOn = []
    accountLookups = []
    nonceIntegrity = true
    installPool()
})

afterEach(() => {
    demos.getAddressNonce = originalNonce
})

describe("nonce admission under nonceIntegrity", () => {
    it("admits the next nonce and locks on the account the nonce edit names", async () => {
        expect((await rpc(await signed(8))).error).toBe("")
        expect(lockedOn).toEqual([`nonce:${SENDER.toLowerCase()}`])
        expect(accountLookups).toEqual([{ where: { pubkey: SENDER.toLowerCase() } }])
    })

    it("admits a gap inside the window, out of order", async () => {
        expect((await rpc(await signed(10))).error).toBe("")
        expect((await gossip(await signed(9))).error).toBe("")
        expect((await rpc(await signed(8))).error).toBe("")
        expect(pool.map(h => h.tx.nonce)).toEqual([10, 9, 8])
    })

    it("admits the far edge of the window and refuses one past it", async () => {
        const edge = confirmedNonce + MEMPOOL_MAX_NONCE_AHEAD
        expect((await rpc(await signed(edge))).error).toBe("")
        const past = await rpc(await signed(edge + 1))
        expect(past.confirmationBlock).toBeNull()
        expect(past.error).toMatch(/too far ahead/)
        expect(pool).toHaveLength(1)
    })

    it("refuses a second pending transaction for the same nonce, from either path", async () => {
        expect((await rpc(await signed(8, 3n))).error).toBe("")
        const viaRpc = await rpc(await signed(8, 4n))
        const viaGossip = await gossip(await signed(8, 5n))
        expect(viaRpc.error).toMatch(/nonce 8 from this sender is already pending/)
        expect(viaGossip.error).toMatch(/already pending/)
        expect(pool).toHaveLength(1)
    })

    it("keeps refusing a nonce at or below the confirmed one", async () => {
        const stale = await rpc(await signed(7))
        expect(stale.error).toMatch(/Invalid nonce/)
        expect(pool).toHaveLength(0)
    })

    it("keeps the window wide enough for a sender's own pending cap not to lock out the gap filler", async () => {
        const { MEMPOOL_MAX_PENDING_PER_SENDER } = await import("@/utilities/constants")
        expect(MEMPOOL_MAX_NONCE_AHEAD).toBeGreaterThan(0)
        expect(MEMPOOL_MAX_NONCE_AHEAD).toBeLessThan(MEMPOOL_MAX_PENDING_PER_SENDER)
    })
})

describe("nonce admission before nonceIntegrity", () => {
    beforeEach(() => {
        nonceIntegrity = false
    })

    it("admits a nonce past the window and a duplicate, as before", async () => {
        const far = confirmedNonce + MEMPOOL_MAX_NONCE_AHEAD + 10
        expect((await rpc(await signed(far))).error).toBe("")
        expect((await rpc(await signed(8, 3n))).error).toBe("")
        expect((await rpc(await signed(8, 4n))).error).toBe("")
        expect(pool).toHaveLength(3)
    })
})
