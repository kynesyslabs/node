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

/**
 * Passes every transaction through the checks other tests cover: the worker
 * pool (coherence and signature), the admission window and identity proofs.
 * What remains is the edit binding and the type rules. Call before importing
 * the mempool.
 */
export function installPoolValidationMocks(): void {
    mock.module("src/libs/blockchain/validation/txValidatorPool", () => ({
        __esModule: true,
        default: {
            getInstance: () => ({
                validate: async (txs: Array<{ hash: string }>) => txs.map(t => ({ valid: true, hash: t.hash })),
            }),
        },
    }))
    mock.module("./validation/txAdmission", () => ({
        checkTxAdmissible: async () => ({ ok: true }),
    }))
    mock.module("./validation/identityAdmission", () => ({
        checkIdentityAdmission: async () => ({ ok: true }),
    }))
}
