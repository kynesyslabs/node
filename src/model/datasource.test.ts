/**
 * The node must never change the schema on its own at boot: migrations are
 * applied by hand (docs/runbooks/database-migrations.md). Building the
 * DataSource does not connect to Postgres, so this runs without a database.
 */

import { describe, it, expect } from "bun:test"
import {
    dataSource,
    assertNoPendingMigrations,
    PendingMigrationsError,
} from "src/model/datasource"

describe("dataSource schema options", () => {
    it("does not run pending migrations at startup", () => {
        expect(dataSource.options.migrationsRun).toBe(false)
    })

    it("does not synchronize the schema from entities", () => {
        expect(dataSource.options.synchronize).toBe(false)
    })

    it("still knows the migrations, so the manual command can apply them", () => {
        expect(dataSource.options.migrations).toEqual([
            "src/migrations/*.{ts,js}",
        ])
    })
})

describe("assertNoPendingMigrations", () => {
    it("refuses to boot when migrations are pending, naming the command", async () => {
        const source = { showMigrations: async () => true }
        const result = assertNoPendingMigrations(source)
        await expect(result).rejects.toBeInstanceOf(PendingMigrationsError)
        await expect(result).rejects.toThrow("bun run migration:run")
    })

    it("lets the node boot when the schema is current", async () => {
        const source = { showMigrations: async () => false }
        await expect(assertNoPendingMigrations(source)).resolves.toBeUndefined()
    })

    it("does not swallow a database error as 'pending'", async () => {
        const source = {
            showMigrations: async () => {
                throw new Error("connect ECONNREFUSED")
            },
        }
        const result = assertNoPendingMigrations(source)
        await expect(result).rejects.toThrow("ECONNREFUSED")
        await expect(result).rejects.not.toBeInstanceOf(PendingMigrationsError)
    })
})
