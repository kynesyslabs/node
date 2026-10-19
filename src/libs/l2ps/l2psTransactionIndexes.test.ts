/**
 * The columns the history table is looked up by must be indexed, and every
 * index the entity declares must be created by a migration.
 *
 * The table is permanent now, so a lookup that scans it costs more with every
 * transaction the subnet ever ran; the status update on the consensus path
 * matches on `hash` and on `encrypted_hash` and is the one that was missed.
 */

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { getMetadataArgsStorage } from "typeorm"
import type { QueryRunner } from "typeorm"
import { L2PSTransaction } from "@/model/entities/L2PSTransactions"
import { IndexL2PSEncryptedHash1791590400000 } from "@/migrations/1791590400000-IndexL2PSEncryptedHash"

const indices = () =>
    getMetadataArgsStorage().indices.filter(i => i.target === L2PSTransaction)

const columnsOf = (index: { columns?: unknown }): string[] =>
    Array.isArray(index.columns) ? (index.columns as string[]) : []

const migrationSource = readdirSync(path.resolve(__dirname, "../../migrations"))
    .filter(f => f.endsWith(".ts"))
    .map(f => readFileSync(path.resolve(__dirname, "../../migrations", f), "utf8"))
    .join("\n")

describe("l2ps_transactions indexes", () => {
    it.each(["hash", "encrypted_hash", "l1_batch_hash", "created_at"])(
        "%s leads an index",
        column => {
            const leads = indices().some(i => columnsOf(i)[0] === column)
            // `hash` is also covered by its unique constraint.
            expect(leads || column === "hash").toBe(true)
        },
    )

    it("the account history read is served by subnet, party and time", () => {
        const sets = indices().map(i => columnsOf(i).join(","))
        expect(sets).toContain("l2ps_uid,from_address,timestamp")
        expect(sets).toContain("l2ps_uid,to_address,timestamp")
    })

    it("every declared index is created by some migration", () => {
        const missing = indices()
            .map(i => i.name)
            .filter(name => !migrationSource.includes(`"${name}"`) && !migrationSource.includes(`\\"${name}\\"`))
        expect(missing).toEqual([])
    })
})

describe("the encrypted_hash migration", () => {
    const recorder = (failOn?: RegExp) => {
        const queries: string[] = []
        let aborted = false
        const runner = {
            query: async (sql: string) => {
                // A failed statement aborts the transaction: until it ends,
                // Postgres refuses everything else, whatever it is.
                if (aborted) throw new Error("current transaction is aborted, commands ignored until end of transaction block")
                queries.push(sql)
                if (failOn?.test(sql)) {
                    aborted = true
                    throw new Error("canceling statement due to lock timeout")
                }
            },
        }
        return { runner: runner as unknown as QueryRunner, queries }
    }

    const entityIndex = () => indices().find(i => columnsOf(i).join(",") === "encrypted_hash")!

    it("up creates the index the entity declares, on the column the entity names", async () => {
        const { runner, queries } = recorder()
        await new IndexL2PSEncryptedHash1791590400000().up(runner)

        const create = queries.find(q => /CREATE INDEX/.test(q))!
        expect(create).toContain(`"${entityIndex().name}"`)
        expect(create).toMatch(/ON "l2ps_transactions" \("encrypted_hash"\)/)
        expect(create).not.toMatch(/CONCURRENTLY/)
    })

    it("up lifts the timeouts for the transaction only", async () => {
        const { runner, queries } = recorder()
        await new IndexL2PSEncryptedHash1791590400000().up(runner)

        expect(queries.slice(0, 2)).toEqual(["SET LOCAL statement_timeout = 0", "SET LOCAL lock_timeout = 0"])
        expect(queries.some(q => /^RESET/.test(q))).toBe(false)
        expect(queries.some(q => /^SET (?!LOCAL)/.test(q))).toBe(false)
    })

    it("up reports the error that aborted the transaction, not a follow-on one", async () => {
        const { runner } = recorder(/CREATE INDEX/)

        await expect(new IndexL2PSEncryptedHash1791590400000().up(runner)).rejects.toThrow("lock timeout")
    })

    it("down drops the same index", async () => {
        const { runner, queries } = recorder()
        await new IndexL2PSEncryptedHash1791590400000().down(runner)

        expect(queries).toEqual([`DROP INDEX IF EXISTS "${entityIndex().name}"`])
    })

    it("the entity carries the index under that name on that column", () => {
        expect(entityIndex()).toBeDefined()
        expect(entityIndex().name).toBe("IDX_L2PS_TX_ENCRYPTED_HASH")
    })
})
