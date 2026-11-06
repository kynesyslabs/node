/**
 * Every node session carries server-side limits, so a stuck query or a lock
 * that is never released ends in an error instead of holding the consensus
 * round forever; the migration CLI runs without them.
 */

import { describe, expect, it } from "bun:test"
import { dataSource, sessionTimeouts } from "./datasource"
import { DEFAULT_CONFIG } from "src/config/defaults"

describe("database session timeouts", () => {
    it("sets statement, lock and idle-in-transaction limits on the node's sessions", () => {
        const extra = (dataSource.options as { extra: Record<string, unknown> })
            .extra
        expect(extra.statement_timeout).toBeGreaterThan(0)
        expect(extra.lock_timeout).toBeGreaterThan(0)
        expect(extra.idle_in_transaction_session_timeout).toBeGreaterThan(0)
        // A client-side timer would leave the statement running on the server.
        expect(extra.query_timeout).toBeUndefined()
    })

    it("leaves room for a full block's statements under the default limits", () => {
        const db = DEFAULT_CONFIG.database
        expect(db.statementTimeoutMs).toBeGreaterThanOrEqual(60_000)
        expect(db.lockTimeoutMs).toBeGreaterThanOrEqual(30_000)
        expect(db.idleTransactionTimeoutMs).toBeGreaterThanOrEqual(30_000)
    })

    it("does not limit the migration CLI", () => {
        const db = {
            statementTimeoutMs: 1,
            lockTimeoutMs: 2,
            idleTransactionTimeoutMs: 3,
        }
        expect(sessionTimeouts(db, ["bun", "cli.js", "migration:run"])).toEqual({})
        expect(sessionTimeouts(db, ["bun", "src/index.ts"])).toEqual({
            statement_timeout: 1,
            lock_timeout: 2,
            idle_in_transaction_session_timeout: 3,
        })
    })
})
