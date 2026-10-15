/**
 * The queue's cleanup, summary and paging queries, against a real Postgres.
 *
 * Opt-in: set L2PS_TEST_PG_URL to a disposable database whose name contains
 * "test" or "tmp", and L2PS_TEST_PG_DISPOSABLE=1. Anything else is refused.
 * The tables live in a schema of their own, created for the run and dropped
 * after it, so nothing already in the database is touched.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from "bun:test"
import { DataSource } from "typeorm"
import { L2PSMempoolTx } from "@/model/entities/L2PSMempool"

const PG_URL = process.env.L2PS_TEST_PG_URL
const SCHEMA = `l2ps_mempool_test_${process.pid}_${Date.now()}`
const MINUTE = 60_000

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

jest.mock("@/model/datasource", () => ({
    __esModule: true,
    default: { getInstance: async () => ({ getDataSource: () => ds }) },
}))
jest.mock("@/libs/blockchain/chain", () => ({ __esModule: true, default: {} }))
jest.mock("@/libs/consensus/v2/types/secretaryManager", () => ({
    __esModule: true,
    default: { getInstance: () => ({}) },
}))
jest.mock("@/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        only: jest.fn(),
    },
}))

const { default: L2PSMempool } = await import("./l2ps_mempool")

let sequence = 0
async function insert(hash: string, status: string, ageMs: number, edits: unknown[] | null, uid = "subnet_a") {
    await ds.getRepository(L2PSMempoolTx).insert({
        hash,
        l2ps_uid: uid,
        sequence_number: String(++sequence),
        original_hash: `orig-${hash}`,
        encrypted_tx: { hash } as never,
        status,
        timestamp: String(Date.now() - ageMs),
        block_number: 1,
        gcr_edits: edits as never,
        affected_accounts_count: 0,
    })
}

describe.skipIf(!PG_URL)("L2PS queue queries on Postgres", () => {
    beforeAll(async () => {
        assertDisposable(PG_URL as string)
        ds = new DataSource({
            type: "postgres",
            url: PG_URL,
            schema: SCHEMA,
            extra: { options: `-c search_path=${SCHEMA}` },
            entities: [L2PSMempoolTx],
        })
        await ds.initialize()
        await ds.query(`CREATE SCHEMA "${SCHEMA}"`)
        await ds.synchronize()
        ;(L2PSMempool as any).repo = ds.getRepository(L2PSMempoolTx)
    })

    afterAll(async () => {
        if (ds?.isInitialized) {
            await ds.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
            await ds.destroy()
        }
    })

    beforeEach(async () => {
        await ds.query(`TRUNCATE "l2ps_mempool"`)
    })

    it("deletes old batched rows that have no edits and keeps everything else", async () => {
        await insert("old-null", "batched", 10 * MINUTE, null)
        await insert("old-empty", "batched", 10 * MINUTE, [])
        await insert("old-edits", "batched", 10 * MINUTE, [{ type: "balance" }])
        await insert("recent-null", "batched", 1 * MINUTE, null)
        await insert("old-executed", "executed", 10 * MINUTE, null)
        await insert("old-failed", "failed", 10 * MINUTE, null)

        expect(await L2PSMempool.cleanupBatchedWithoutEdits(5 * MINUTE)).toBe(2)

        const left = (await ds.getRepository(L2PSMempoolTx).find()).map(r => r.hash).sort()
        expect(left).toEqual(["old-edits", "old-executed", "old-failed", "recent-null"])
    })

    it("summarises a status without loading rows", async () => {
        await insert("a", "executed", 3 * MINUTE, null)
        await insert("b", "executed", 1 * MINUTE, null)
        await insert("c", "batched", 2 * MINUTE, null)
        await insert("d", "executed", 2 * MINUTE, null, "subnet_b")

        const summary = await L2PSMempool.getSummaryByUIDAndStatus("subnet_a", "executed")
        expect(summary.count).toBe(2)
        expect(Number(summary.newestTimestamp)).toBeGreaterThan(Number(summary.oldestTimestamp))

        const none = await L2PSMempool.getSummaryByUIDAndStatus("subnet_a", "failed")
        expect(none).toEqual({ count: 0, oldestTimestamp: null, newestTimestamp: null })
    })

    it("pages the queue oldest first after a cursor, capped by the limit", async () => {
        for (let i = 0; i < 12; i++) await insert(`row-${i}`, "executed", (20 - i) * 1000, null)

        const first = await L2PSMempool.getPageByUID("subnet_a", 0, 5)
        expect(first.map(r => r.hash)).toEqual(["row-0", "row-1", "row-2", "row-3", "row-4"])
        expect((first[0] as any).encrypted_tx).toBeUndefined()

        const next = await L2PSMempool.getPageByUID("subnet_a", Number(first[4].timestamp), 5)
        expect(next.map(r => r.hash)).toEqual(["row-5", "row-6", "row-7", "row-8", "row-9"])
    })

    it("hashes the executed rows in hash order", async () => {
        await insert("0xbb", "executed", 2000, null)
        await insert("0xaa", "executed", 1000, null)
        await insert("0xcc", "batched", 3000, null)

        const hash = await L2PSMempool.getHashForL2PS("subnet_a")
        expect(hash).toBe(await L2PSMempool.getHashForL2PS("subnet_a"))
        expect(hash).not.toBe(await L2PSMempool.getHashForL2PS("subnet_b"))
    })
})
