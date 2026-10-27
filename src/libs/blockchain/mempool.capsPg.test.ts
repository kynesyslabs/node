/**
 * The mempool admission queries (pool usage, per-sender counts, eviction
 * ranking inputs, lifetime sweep) against a real Postgres.
 *
 * Opt-in: set L2PS_TEST_PG_URL to a disposable database whose name contains
 * "test" or "tmp", and L2PS_TEST_PG_DISPOSABLE=1. Anything else is refused.
 * The table lives in a schema of its own, created for the run and dropped
 * after it, so nothing already in the database is touched.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test"
import { mockMempoolDeps } from "@/libs/blockchain/testSupport/mockMempoolDeps"
import { DataSource } from "typeorm"
import { MempoolTx } from "@/model/entities/Mempool"

const PG_URL = process.env.L2PS_TEST_PG_URL
const SCHEMA = `mempool_caps_test_${process.pid}_${Date.now()}`
const NOW = 1_800_000_000_000

function assertDisposable(url: string): void {
    if (process.env.L2PS_TEST_PG_DISPOSABLE !== "1") {
        throw new Error("L2PS_TEST_PG_URL is set but L2PS_TEST_PG_DISPOSABLE=1 is not; refusing to run")
    }
    const database = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""))
    if (!/test|tmp/i.test(database)) {
        throw new Error(`Database "${database}" does not look disposable (no "test" or "tmp" in its name); refusing to run`)
    }
}

let ds: DataSource

const OWN_KEY = "0x" + "aa".repeat(32)

mockMempoolDeps(() => ds)
// The real shared state pulls in the whole network stack, bridge SDK and
// its tron dependency included, none of which these queries touch.
mock.module("src/utilities/sharedState", () => ({
    getSharedState: {
        lastBlockNumber: 100,
        referenceBlockRoom: 1,
        publicKeyHex: OWN_KEY,
        inConsensusLoop: false,
    },
}))
mock.module("@/utilities/sharedState", () => ({
    getSharedState: {
        lastBlockNumber: 100,
        referenceBlockRoom: 1,
        publicKeyHex: OWN_KEY,
        inConsensusLoop: false,
    },
}))
mock.module("src/libs/network/manageBridge", () => ({ __esModule: true, default: () => undefined }))

const { default: Mempool } = await import("./mempool")
const { txStoredBytes, txTotalFee, __resetMempoolLimits } = await import("./mempoolLimits")

function row(hash: string, over: { from?: string; type?: string; ts?: unknown; fee?: unknown; extra?: unknown; ed?: string } = {}) {
    return {
        hash,
        timestamp: BigInt(NOW),
        content: {
            type: over.type ?? "native",
            from: over.from ?? "0xaaa",
            timestamp: "ts" in over ? over.ts : NOW,
            transaction_fee: "fee" in over ? over.fee : { network_fee: 1, rpc_fee: 1, additional_fee: 1 },
        },
        signature: { type: "ed25519", data: "ffee" },
        ed25519_signature: over.ed ?? null,
        status: "pending",
        blockNumber: 1,
        extra: over.extra ?? null,
        nonce: 0,
        reference_block: 1,
    } as never
}

describe.skipIf(!PG_URL)("mempool admission queries on Postgres", () => {
    beforeAll(async () => {
        assertDisposable(PG_URL as string)
        ds = new DataSource({
            type: "postgres",
            url: PG_URL,
            schema: SCHEMA,
            extra: { options: `-c search_path=${SCHEMA}` },
            entities: [MempoolTx],
        })
        await ds.initialize()
        await ds.query(`CREATE SCHEMA "${SCHEMA}"`)
        await ds.synchronize()
        ;(Mempool as any).repo = ds.getRepository(MempoolTx)
    })

    afterAll(async () => {
        __resetMempoolLimits()
        if (ds?.isInitialized) {
            await ds.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
            await ds.destroy()
        }
    })

    beforeEach(async () => {
        await ds.query('TRUNCATE "mempooltx"')
        ;(Mempool as any).lastAgeSweep = 0
    })

    it("totals count and stored bytes exactly as txStoredBytes measures one tx", async () => {
        const rows = [
            row("0x1"),
            row("0x2", { ed: "edsig" }),
            row("0x3", { extra: { a: 1 } }),
            row("0x4", { from: "0xmulti-é€" }),
        ]
        await ds.getRepository(MempoolTx).insert(rows)

        const usage = await Mempool.getUsage()
        expect(usage.count).toBe(4)
        // `extra` is jsonb, whose text form puts a space after the colon.
        const jsonbSlack = 1
        expect(usage.bytes).toBe(
            rows.reduce((n, r) => n + txStoredBytes(r as never), 0) + jsonbSlack,
        )
    })

    it("reports an empty pool as zero", async () => {
        expect(await Mempool.getUsage()).toEqual({ count: 0, bytes: 0 })
    })

    it("counts pending txs per sender case-insensitively, whatever their reference block", async () => {
        await ds.getRepository(MempoolTx).insert([
            row("0x1", { from: "0xAbC" }),
            row("0x2", { from: "0xabc" }),
            { ...(row("0x3", { from: "0xABC" }) as object), reference_block: 0 } as never,
            row("0x4", { from: "0xdef" }),
        ])
        const counts = await Mempool.countPendingBySenders(["0xAbC", "0xdef", "0xnobody"])
        expect(Object.fromEntries(counts)).toEqual({ "0xabc": 3, "0xdef": 1 })
        expect((await Mempool.countPendingBySenders([])).size).toBe(0)
    })

    it("lists each row's signed timestamp, fee and size for eviction ranking", async () => {
        await ds.getRepository(MempoolTx).insert([
            row("0xpays", { ts: NOW - 5, fee: { network_fee: 2, rpc_fee: "3", additional_fee: 0 } }),
            row("0xnofee", { fee: null }),
            row("0xbadts", { ts: "not-a-number" }),
        ])
        const byHash = Object.fromEntries(
            (await Mempool.listEvictionCandidates()).map(c => [c.hash, c]),
        )
        expect(byHash["0xpays"].timestamp).toBe(NOW - 5)
        expect(byHash["0xpays"].fee).toBe(2_000_000_003n)
        expect(byHash["0xnofee"].fee).toBe(0n)
        expect(byHash["0xbadts"].timestamp).toBe(0)
        expect(byHash["0xpays"].bytes).toBe(txStoredBytes(row("0xpays", { ts: NOW - 5, fee: { network_fee: 2, rpc_fee: "3", additional_fee: 0 } }) as never))
        expect(txTotalFee({ network_fee: 2, rpc_fee: "3" })).toBe(2_000_000_003n)
    })

    it("sweeps txs past their signed lifetime, reading the content and not the row's own timestamp", async () => {
        const tenMinutes = 10 * 60 * 1000
        await ds.getRepository(MempoolTx).insert([
            row("0xold", { ts: NOW - tenMinutes - 1 }),
            row("0xfresh", { ts: NOW - tenMinutes + 1000 }),
            // A relaying peer controls the row timestamp; the signed content wins.
            { ...(row("0xliar", { ts: NOW - tenMinutes - 5000 }) as object), timestamp: BigInt(NOW) } as never,
        ])

        expect(await Mempool.pruneExpiredByAge(NOW)).toBe(2)
        const left = (await ds.getRepository(MempoolTx).find()).map(r => r.hash).sort()
        expect(left).toEqual(["0xfresh"])
    })

    it("sweeps exactly the timestamps the admission check rejects as unusable", async () => {
        const { checkTxAge } = await import("./mempoolLimits")
        const cases: Record<string, unknown> = {
            "0xmissing": undefined,
            "0xstring": String(NOW),
            "0xfraction": NOW + 0.5,
            "0xzero": 0,
            "0xnegative": -5,
            "0xnull": null,
            "0xhuge": 1e16,
            "0xok": NOW,
        }
        for (const [hash, ts] of Object.entries(cases)) {
            await ds.getRepository(MempoolTx).insert([row(hash, { ts })])
        }
        await Mempool.pruneExpiredByAge(NOW)
        const left = (await ds.getRepository(MempoolTx).find()).map(r => r.hash)
        expect(left).toEqual(["0xok"])
        for (const [hash, ts] of Object.entries(cases)) {
            const verdict = checkTxAge({ content: { timestamp: ts } } as never, NOW)
            expect(verdict === null).toBe(hash === "0xok")
        }
    })

    it("neither sweeps nor offers for eviction the node's own relay txs, but does for anyone else's", async () => {
        await ds.getRepository(MempoolTx).insert([
            // Network clock in seconds: far older than any millisecond lifetime.
            row("0xown-relay", { from: OWN_KEY, type: "l2psBatch", ts: Math.floor(NOW / 1000) }),
            row("0xfake-relay", { from: "0xsomeone", type: "l2psBatch", ts: Math.floor(NOW / 1000) }),
            row("0xplain", { ts: NOW }),
        ])
        expect((await Mempool.listEvictionCandidates()).map(c => c.hash).sort()).toEqual([
            "0xfake-relay",
            "0xplain",
        ])
        expect(await Mempool.pruneExpiredByAge(NOW)).toBe(1)
        const left = (await ds.getRepository(MempoolTx).find()).map(r => r.hash).sort()
        expect(left).toEqual(["0xown-relay", "0xplain"])
    })

    it("throttles repeated sweeps unless forced", async () => {
        await Mempool.pruneExpiredByAge(NOW)
        await ds.getRepository(MempoolTx).insert([row("0xold", { ts: NOW - 20 * 60 * 1000 })])
        expect(await Mempool.pruneExpiredByAge(NOW + 500)).toBe(0)
        expect(await Mempool.pruneExpiredByAge(NOW + 500, true)).toBe(1)
    })

    it("plans eviction against the real pool for an RPC tx and leaves the pool untouched", async () => {
        const { __setMempoolLimits } = await import("./mempoolLimits")
        __setMempoolLimits({ maxTxs: 2 })
        try {
            await ds.getRepository(MempoolTx).insert([
                row("0xcheap", { ts: Date.now(), fee: { network_fee: 1 } }),
                row("0xdear", { ts: Date.now(), fee: { network_fee: 9 } }),
            ])
            const incoming = row("0xnew", { ts: Date.now(), fee: { network_fee: 5 } }) as any
            const plan = await Mempool.checkAdmission(incoming, "gossip")
            expect(plan).toEqual({ reason: "pool_full" })
            const left = (await ds.getRepository(MempoolTx).find()).map(r => r.hash).sort()
            expect(left).toEqual(["0xcheap", "0xdear"])
        } finally {
            __resetMempoolLimits()
        }
    })
})
