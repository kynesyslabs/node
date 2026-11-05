/**
 * Replaces the database, the chain and the pool's row insert for tests of
 * the doors into the mempool. Returns the rows the pool inserts. Call before
 * importing the mempool.
 */

import { mock } from "bun:test"

export function installPoolStorageMocks(): Array<Record<string, unknown>> {
    const inserted: Array<Record<string, unknown>> = []
    mock.module("@/model/datasource", () => ({
        __esModule: true,
        default: { getInstance: async () => ({}) },
    }))
    mock.module("src/libs/blockchain/chain", () => ({
        __esModule: true,
        default: {
            getLastBlockNumber: async () => 100,
            getExistingTransactionHashes: async () => new Set<string>(),
            checkTxExists: async () => false,
        },
    }))
    mock.module("src/libs/blockchain/chainDb", () => ({
        chunkedInsert: async (_repo: unknown, _entity: unknown, rows: Array<Record<string, unknown>>) => {
            inserted.push(...rows)
            return { inserted: rows.length }
        },
    }))
    mock.module("src/libs/consensus/v2/types/secretaryManager", () => ({
        __esModule: true,
        default: class {
            static lastBlockRef = 100
        },
    }))
    return inserted
}
