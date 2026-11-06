/**
 * The database and mempool under the transaction status read, replaced for a
 * test. Call it before chainTransactions is imported.
 */
import { jest } from "bun:test"

export function mockTransactionStore() {
    const findOneBy = jest.fn(async (..._args: unknown[]) => null as any)
    const findByHash = jest.fn(async (..._args: unknown[]) => null as any)
    jest.mock("src/libs/blockchain/chainDb", () => ({
        __esModule: true,
        getBlocksRepo: jest.fn(),
        getTransactionsRepo: () => ({ findOneBy }),
        setupChainDb: jest.fn(),
        readSql: jest.fn(),
        writeSql: jest.fn(),
        maxRowsPerInsert: jest.fn(() => 1000),
        chunkedInsert: jest.fn(),
    }))
    jest.mock("src/libs/blockchain/mempool", () => ({ __esModule: true, default: { findByHash } }))
    jest.mock("src/utilities/logger", () => ({
        __esModule: true,
        default: new Proxy({}, { get: () => jest.fn() }),
    }))
    return { findOneBy, findByHash }
}
