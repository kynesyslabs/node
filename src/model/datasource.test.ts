/**
 * The node must never change the schema on its own at boot: migrations are
 * applied by hand (docs/runbooks/database-migrations.md). Building the
 * DataSource does not connect to Postgres, so this runs without a database.
 */

import { describe, it, expect } from "bun:test"
import { dataSource } from "src/model/datasource"

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
