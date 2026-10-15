/**
 * The queue's cleanup, summary and paging queries, against a real Postgres.
 *
 * Opt-in: set L2PS_TEST_PG_URL to a disposable database whose name contains
 * "test" or "tmp", and L2PS_TEST_PG_DISPOSABLE=1. Anything else is refused.
 * The tables live in a schema of their own, created for the run and dropped
 * after it, so nothing already in the database is touched.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest, mock } from "bun:test"
import { DataSource } from "typeorm"
import { Hashing } from "@kynesyslabs/demosdk/encryption"
import { L2PSMempoolTx } from "@/model/entities/L2PSMempool"
import { L2PSTransaction } from "@/model/entities/L2PSTransactions"

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

mock.module("@/model/datasource", () => ({
    __esModule: true,
    default: { getInstance: async () => ({ getDataSource: () => ds }) },
}))
mock.module("@/libs/blockchain/chain", () => ({ __esModule: true, default: {} }))
mock.module("@/libs/consensus/v2/types/secretaryManager", () => ({
    __esModule: true,
    default: { getInstance: () => ({}) },
}))
mock.module("@/utilities/logger", () => ({
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

/** The history row for a queue row's original hash; payload null stands for a row from before ciphertext was kept. */
async function insertHistory(hash: string, payload: Record<string, unknown> | null) {
    await ds.getRepository(L2PSTransaction).insert({
        l2ps_uid: "subnet_a",
        hash: `orig-${hash}`,
        type: "instantMessaging",
        from_address: "a",
        to_address: "b",
        amount: 0n,
        nonce: 0n,
        timestamp: 1n,
        encrypted_payload: payload,
    } as never)
}

describe.skipIf(!PG_URL)("L2PS queue queries on Postgres", () => {
    beforeAll(async () => {
        assertDisposable(PG_URL as string)
        ds = new DataSource({
            type: "postgres",
            url: PG_URL,
            schema: SCHEMA,
            extra: { options: `-c search_path=${SCHEMA}` },
            entities: [L2PSMempoolTx, L2PSTransaction],
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
        await ds.query(`TRUNCATE "l2ps_mempool", "l2ps_transactions" RESTART IDENTITY`)
    })

    it("deletes old batched rows that have no edits and a stored ciphertext, and keeps everything else", async () => {
        await insert("old-null", "batched", 10 * MINUTE, null)
        await insert("old-empty", "batched", 10 * MINUTE, [])
        await insert("old-edits", "batched", 10 * MINUTE, [{ type: "balance" }])
        await insert("recent-null", "batched", 1 * MINUTE, null)
        await insert("old-executed", "executed", 10 * MINUTE, null)
        await insert("old-failed", "failed", 10 * MINUTE, null)
        for (const hash of ["old-null", "old-empty", "old-edits", "recent-null", "old-executed", "old-failed"]) {
            await insertHistory(hash, { hash })
        }

        expect(await L2PSMempool.cleanupBatchedWithoutEdits(5 * MINUTE)).toBe(2)

        const left = (await ds.getRepository(L2PSMempoolTx).find()).map(r => r.hash).sort()
        expect(left).toEqual(["old-edits", "old-executed", "old-failed", "recent-null"])
    })

    it("keeps a legacy row whose history entry holds no ciphertext, or has no entry at all", async () => {
        await insert("legacy-null-payload", "batched", 10 * MINUTE, null)
        await insert("legacy-no-history", "batched", 10 * MINUTE, null)
        await insert("modern", "batched", 10 * MINUTE, null)
        await insertHistory("legacy-null-payload", null)
        await insertHistory("modern", { hash: "modern" })

        expect(await L2PSMempool.cleanupBatchedWithoutEdits(5 * MINUTE)).toBe(1)

        const left = (await ds.getRepository(L2PSMempoolTx).find()).map(r => r.hash).sort()
        expect(left).toEqual(["legacy-no-history", "legacy-null-payload"])
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

        const first = await L2PSMempool.getPageByUID("subnet_a", { timestamp: 0 }, 5)
        expect(first.map(r => r.hash)).toEqual(["row-0", "row-1", "row-2", "row-3", "row-4"])
        expect((first[0] as any).encrypted_tx).toBeUndefined()

        const next = await L2PSMempool.getPageByUID("subnet_a", { timestamp: Number(first[4].timestamp) }, 5)
        expect(next.map(r => r.hash)).toEqual(["row-5", "row-6", "row-7", "row-8", "row-9"])
    })

    it("pages through rows that share a millisecond with the (timestamp, hash) cursor", async () => {
        const at = String(Date.now() - 60_000)
        for (const hash of ["e", "b", "d", "a", "c"]) {
            await ds.getRepository(L2PSMempoolTx).insert({
                hash, l2ps_uid: "subnet_a", sequence_number: String(++sequence), original_hash: `o-${hash}`,
                encrypted_tx: {} as never, status: "executed", timestamp: at, block_number: 1, gcr_edits: null as never,
                affected_accounts_count: 0,
            })
        }

        const seen: string[] = []
        let cursor: { timestamp: number; hash?: string } = { timestamp: 0 }
        for (let page = 0; page < 10; page++) {
            const rows = await L2PSMempool.getPageByUID("subnet_a", cursor, 2)
            if (rows.length === 0) break
            seen.push(...rows.map(r => r.hash))
            cursor = { timestamp: Number(rows.at(-1)!.timestamp), hash: rows.at(-1)!.hash }
        }

        expect(seen).toEqual(["a", "b", "c", "d", "e"])
    })

    it("lists each subnet with executed rows once", async () => {
        await insert("a1", "executed", MINUTE, null, "subnet_b")
        await insert("a2", "executed", MINUTE, null, "subnet_b")
        await insert("a3", "executed", MINUTE, null, "subnet_a")
        await insert("a4", "batched", MINUTE, null, "subnet_c")

        expect(await L2PSMempool.getExecutedSubnets()).toEqual(["subnet_a", "subnet_b"])
    })

    it("looks rows up by original hash within the wanted statuses", async () => {
        await insert("a", "batched", MINUTE, null)
        await insert("b", "executed", MINUTE, null)
        await insert("c", "failed", MINUTE, null)
        await insert("d", "batched", MINUTE, null, "subnet_b")

        const found = await L2PSMempool.getByOriginalHashes(
            "subnet_a",
            ["orig-a", "orig-c", "orig-d", "orig-missing"],
            ["executed", "batched", "confirmed"],
        )

        expect(found.map(r => r.hash)).toEqual(["a"])
        expect(await L2PSMempool.getByOriginalHashes("subnet_a", [], ["batched"])).toEqual([])
    })

    // The digest as it was defined when every row was loaded and sorted in memory.
    const referenceDigest = async (uid: string, blockNumber?: number) => {
        const rows = await ds.getRepository(L2PSMempoolTx).find({
            where: { l2ps_uid: uid, status: "executed", ...(blockNumber === undefined ? {} : { block_number: blockNumber }) },
        })
        const sorted = rows.map(r => r.hash).sort()
        if (sorted.length === 0) return Hashing.sha256(`L2PS_EMPTY_${uid}${blockNumber === undefined ? "_ALL" : `_BLOCK_${blockNumber}`}`)
        const suffix = blockNumber === undefined ? "_ALL" : `_BLOCK_${blockNumber}`
        return Hashing.sha256(`L2PS_${uid}${suffix}:${sorted.length}:${sorted.join(",")}`)
    }

    async function seed(count: number, allExecuted = false): Promise<void> {
        // Upper and lower case, an underscore and a digit-first form, so that a
        // locale-aware ordering would differ from the code-unit order of .sort().
        await ds.query(
            `INSERT INTO l2ps_mempool (hash, l2ps_uid, sequence_number, original_hash, encrypted_tx, status, timestamp, block_number, gcr_edits, affected_accounts_count)
             SELECT CASE g % 4 WHEN 0 THEN '0x' || md5(g::text) WHEN 1 THEN '0x' || upper(md5(g::text)) WHEN 2 THEN 'A_' || md5(g::text) ELSE 'a-' || md5(g::text) END,
                    'subnet_a', g, 'o' || g, '{}'::jsonb, CASE WHEN g % 10 = 0 AND NOT $2::boolean THEN 'batched' ELSE 'executed' END, 1700000000000 + g, 1 + g % 3, null, 0
             FROM generate_series(1, $1::int) g`,
            [count, allExecuted],
        )
    }

    it("computes the same digest as loading and sorting every row, across several pages", async () => {
        await seed(12_345)

        expect(await L2PSMempool.getHashForL2PS("subnet_a")).toBe(await referenceDigest("subnet_a"))
    })

    it("computes the same digest for a block filter and for an empty subnet", async () => {
        await seed(12_345)
        expect(await L2PSMempool.getHashForL2PS("subnet_a", 2)).toBe(await referenceDigest("subnet_a", 2))
        expect(await L2PSMempool.getHashForL2PS("subnet_missing")).toBe(await referenceDigest("subnet_missing"))
    })

    it("computes the same digest when the backlog is exactly two pages", async () => {
        await seed(10_000, true)
        const executed = Number((await ds.query(`SELECT count(*) FROM l2ps_mempool WHERE status = 'executed'`))[0].count)
        expect(executed).toBe(10_000)

        expect(await L2PSMempool.getHashForL2PS("subnet_a")).toBe(await referenceDigest("subnet_a"))
        expect((await L2PSMempool.getDigestWithCount("subnet_a")).count).toBe(10_000)
    })

    it("hashes exactly one page when the backlog is a whole number of pages", async () => {
        await seed(100)
        await ds.query(`DELETE FROM l2ps_mempool WHERE status = 'batched'`)
        await ds.query(
            `INSERT INTO l2ps_mempool (hash, l2ps_uid, sequence_number, original_hash, encrypted_tx, status, timestamp, block_number, gcr_edits, affected_accounts_count)
             SELECT 'x' || g, 'subnet_b', g, 'ox' || g, '{}'::jsonb, 'executed', 1, 1, null, 0 FROM generate_series(1, 5000) g`,
        )

        expect(await L2PSMempool.getHashForL2PS("subnet_b")).toBe(await referenceDigest("subnet_b"))
    })
})
