/**
 * The on-chain TLSNotary token table against a real Postgres: the baseline
 * schema plus the TlsnOnChainTokens migration hold what the entity writes
 * (a pending token has no proof), the attestation id is unique, rows written
 * before the fork survive, and the migration rolls back.
 *
 * Opt-in: set TLSN_TEST_PG_URL to a disposable database whose name contains
 * "test" or "tmp", and TLSN_TEST_PG_DISPOSABLE=1. Anything else is refused.
 * The tables live in a schema created for the run and dropped after it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { DataSource, type QueryRunner } from "typeorm"
import { GCRTLSNotary } from "@/model/entities/GCRv2/GCR_TLSNotary"
import { BaselineSchema1779062400000 } from "@/migrations/1779062400000-BaselineSchema"
import { TlsnOnChainTokens1794268800000 } from "@/migrations/1794268800000-TlsnOnChainTokens"
import { tlsnTableDigest } from "@/libs/blockchain/gcr/gcr_routines/hashGCR"
import { tlsnRequestOf } from "./onchainRequests"

const PG_URL = process.env.TLSN_TEST_PG_URL
const SCHEMA = `tlsn_test_${process.pid}_${Date.now()}`

function assertDisposable(url: string): void {
    if (process.env.TLSN_TEST_PG_DISPOSABLE !== "1") {
        throw new Error("TLSN_TEST_PG_URL is set but TLSN_TEST_PG_DISPOSABLE=1 is not; refusing to run")
    }
    const database = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""))
    if (!/test|tmp/i.test(database)) {
        throw new Error(`Database "${database}" does not look disposable (no "test" or "tmp" in its name); refusing to run`)
    }
}

let ds: DataSource
let runner: QueryRunner
const migration = new TlsnOnChainTokens1794268800000()
const repo = () => ds.getRepository(GCRTLSNotary)
const hash = (byte: string) => byte.repeat(32)

const pending = (tokenId: string, extra: Partial<GCRTLSNotary> = {}) =>
    ({
        tokenId,
        owner: "0xowner",
        domain: "api.github.com",
        proof: null,
        storageType: null,
        txhash: tokenId,
        proofTimestamp: "0",
        status: "pending",
        requestHeight: 101,
        expiresAtHeight: 601,
        attestationId: null,
        storedAtHeight: null,
        ...extra,
    }) as GCRTLSNotary

describe.skipIf(!PG_URL)("TLSNotary token table on Postgres", () => {
    beforeAll(async () => {
        assertDisposable(PG_URL as string)
        ds = new DataSource({
            type: "postgres",
            url: PG_URL,
            schema: SCHEMA,
            // The migrations name tables unqualified.
            extra: { options: `-c search_path=${SCHEMA}` },
            entities: [GCRTLSNotary],
        })
        await ds.initialize()
        await ds.query(`CREATE SCHEMA "${SCHEMA}"`)
        runner = ds.createQueryRunner()
        await new BaselineSchema1779062400000().up(runner)
        // A proof stored before the fork, as the old schema holds it.
        await ds.query(
            `INSERT INTO "gcr_tlsnotary" ("tokenId","owner","domain","proof","storageType","txhash","proofTimestamp")
             VALUES ('legacy-1','0xold','example.com','{}','onchain','tx-legacy',1)`,
        )
        await migration.up(runner)
    })

    afterAll(async () => {
        if (ds?.isInitialized) {
            await runner?.release()
            await ds.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
            await ds.destroy()
        }
    })

    beforeEach(async () => {
        await ds.query(`DELETE FROM "gcr_tlsnotary" WHERE "tokenId" <> 'legacy-1'`)
    })

    it("leaves nothing for the entity to change in the migrated table", async () => {
        const sql = await ds.driver.createSchemaBuilder().log()
        const tlsn = sql.upQueries.map(q => q.query).filter(q => q.includes("gcr_tlsnotary"))
        expect(tlsn).toEqual([])
    })

    it("keeps a pre-fork row, which reads as no token", async () => {
        const legacy = await repo().findOneByOrFail({ tokenId: "legacy-1" })
        expect(legacy.status).toBeNull()
        expect(tlsnRequestOf(legacy)).toBeNull()
    })

    it("stores a pending token without a proof and reads it back as the chain's request", async () => {
        await repo().save(pending(hash("a1")))

        const row = await repo().findOneByOrFail({ tokenId: hash("a1") })
        expect(tlsnRequestOf(row)).toEqual({
            tokenId: hash("a1"),
            owner: "0xowner",
            domain: "api.github.com",
            status: "pending",
            requestHeight: 101,
            expiresAtHeight: 601,
        })
    })

    it("refuses a second row with an attestation id already stored, and allows many without one", async () => {
        await repo().save(pending(hash("b1")))
        await repo().save(pending(hash("b2")))
        await repo().save(pending(hash("b3"), { status: "stored", attestationId: "att-1", proof: "{}", storageType: "onchain" }))

        await expect(
            repo().save(pending(hash("b4"), { status: "stored", attestationId: "att-1", proof: "{}", storageType: "onchain" })),
        ).rejects.toThrow()
    })

    it("hashes the same table on two nodes whose rows carry different createdAt", async () => {
        await repo().save(pending(hash("c1")))
        const here = await repo().find({ where: { status: "pending" } })
        await ds.query(`UPDATE "gcr_tlsnotary" SET "createdAt" = "createdAt" - interval '7 hours'`)
        const there = await repo().find({ where: { status: "pending" } })

        expect(here[0].createdAt).not.toEqual(there[0].createdAt)
        expect(tlsnTableDigest(here, true)).toBe(tlsnTableDigest(there, true))
        expect(tlsnTableDigest(here, false)).not.toBe(tlsnTableDigest(there, false))
    })

    it("rolls back to the old schema, dropping pending tokens, and forward again", async () => {
        await repo().save(pending(hash("d1")))

        await migration.down(runner)
        const left = await ds.query(`SELECT "tokenId" FROM "gcr_tlsnotary"`)
        expect(left.map((r: { tokenId: string }) => r.tokenId)).toEqual(["legacy-1"])
        await expect(
            ds.query(`INSERT INTO "gcr_tlsnotary" ("tokenId","owner","domain","txhash","proofTimestamp") VALUES ('x','o','d','t',0)`),
        ).rejects.toThrow()

        await migration.up(runner)
        await repo().save(pending(hash("d2")))
        expect(await repo().count()).toBe(2)
    })
})
