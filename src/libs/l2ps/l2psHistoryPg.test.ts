/**
 * History retention and the sync time cursor, against a real Postgres.
 *
 * `created_at` is `timestamp` without a zone, filled by the database's
 * `now()`. node-postgres serialises a JS Date in the process's local zone and
 * the cast drops the offset, so a Date compared with that column is off by the
 * process's UTC offset. Run this under more than one `TZ` to see it.
 *
 * Opt-in: set L2PS_TEST_PG_URL to a disposable database whose name contains
 * "test" or "tmp", and L2PS_TEST_PG_DISPOSABLE=1. Anything else is refused.
 * Even then the tables live in a schema of their own, created for the run and
 * dropped after it, so nothing already in the database is touched.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from "bun:test"
import { DataSource } from "typeorm"
import { L2PSTransaction } from "@/model/entities/L2PSTransactions"
import { L2PSExecutedHash } from "@/model/entities/L2PSExecutedHashes"

const PG_URL = process.env.L2PS_TEST_PG_URL
const HOUR = 60 * 60 * 1000
const SCHEMA = `l2ps_test_${process.pid}_${Date.now()}`

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

jest.mock("src/config", () => ({
    Config: { getInstance: () => ({ l2ps: { historyStorePlaintext: false } }) },
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

jest.mock("@/model/datasource", () => ({
    __esModule: true,
    default: { getInstance: async () => ({ getDataSource: () => ds }) },
}))

import L2PSTransactionExecutor from "./L2PSTransactionExecutor"

async function insertAged(hash: string, ageMs: number): Promise<void> {
    await ds.getRepository(L2PSTransaction).insert({
        l2ps_uid: "subnet-1",
        hash,
        type: "native",
        from_address: "a",
        to_address: "b",
        amount: 0n,
        nonce: 0n,
        timestamp: 1n,
    } as never)
    // Aged by the database's own clock, the way `now()` wrote it.
    await ds.query(
        `UPDATE "l2ps_transactions" SET "created_at" = now()::timestamp - make_interval(secs => $2::double precision / 1000) WHERE "hash" = $1`,
        [hash, ageMs],
    )
}

describe.skipIf(!PG_URL)(`L2PS history on Postgres (TZ=${process.env.TZ ?? "unset"})`, () => {
    beforeAll(async () => {
        assertDisposable(PG_URL as string)
        ds = new DataSource({
            type: "postgres",
            url: PG_URL,
            schema: SCHEMA,
            // The executor's raw SQL names tables unqualified.
            extra: { options: `-c search_path=${SCHEMA}` },
            entities: [L2PSTransaction, L2PSExecutedHash],
        })
        await ds.initialize()
        await ds.query(`CREATE SCHEMA "${SCHEMA}"`)
        await ds.synchronize()
    })

    afterAll(async () => {
        if (ds?.isInitialized) {
            await ds.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
            await ds.destroy()
        }
    })

    beforeEach(async () => {
        await ds.query(`TRUNCATE "l2ps_transactions", "l2ps_executed_hashes" RESTART IDENTITY`)
        ;(L2PSTransactionExecutor as unknown as { l1Repo: unknown }).l1Repo = {}
    })

    it("prunes by age whatever the process time zone", async () => {
        await insertAged("old", 3 * HOUR)
        await insertAged("recent", 1 * HOUR)

        await expect(L2PSTransactionExecutor.pruneHistory(2 / 24)).resolves.toBe(1)

        const left = await ds.getRepository(L2PSTransaction).find()
        expect(left.map(r => r.hash)).toEqual(["recent"])
    })

    it("serves rows recorded after a peer's time cursor whatever the process time zone", async () => {
        await insertAged("old", 3 * HOUR)
        await insertAged("recent", 1 * HOUR)

        const page = await L2PSTransactionExecutor.getSubnetTransactions("subnet-1", 100, {
            sinceMs: Date.now() - 2 * HOUR,
        })

        expect(page.rows.map(r => r.hash)).toEqual(["recent"])
    })

    it("still refuses a pruned transfer as already executed", async () => {
        await insertAged("paid-out", 3 * HOUR)
        expect(await L2PSTransactionExecutor.hasExecuted("paid-out")).toBe(true)

        await L2PSTransactionExecutor.pruneHistory(2 / 24)

        expect(await ds.getRepository(L2PSTransaction).count()).toBe(0)
        expect(await L2PSTransactionExecutor.hasExecuted("paid-out")).toBe(true)
        expect(await L2PSTransactionExecutor.hasExecuted("never-ran")).toBe(false)
    })
})
