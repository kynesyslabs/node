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
import { L2PSTransaction } from "@/model/entities/L2PSTransactions"

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
    const source = readFileSync(
        path.resolve(__dirname, "../../migrations/1791590400000-IndexL2PSEncryptedHash.ts"),
        "utf8",
    )

    it("puts back the timeouts it lifts, because they outlive it on a pooled connection", () => {
        expect(source).toMatch(/SET statement_timeout = 0/)
        expect(source).toMatch(/RESET statement_timeout/)
        expect(source).toMatch(/RESET lock_timeout/)
    })

    it("can be run twice and rolled back", () => {
        expect(source).toContain("CREATE INDEX IF NOT EXISTS")
        expect(source).toContain("DROP INDEX IF EXISTS")
    })
})
