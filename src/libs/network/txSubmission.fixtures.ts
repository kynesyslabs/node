/**
 * Replaces what RPC submission reaches beyond the edit binding and the type
 * rules, for tests of `submitValidatedTx`: the chain (tip at 100), the gossip
 * mesh and the confirmation estimate. Call before importing txSubmission.
 */

import { afterEach, beforeEach, mock } from "bun:test"
import type { Transaction } from "@kynesyslabs/demosdk/types"

export function installSubmissionMocks(): void {
    mock.module("src/libs/blockchain/chain", () => ({
        __esModule: true,
        default: { getLastBlockNumber: async () => 100 },
    }))
    mock.module("src/libs/gossip/GossipManager", () => ({
        __esModule: true,
        default: { isEnabled: () => false },
    }))
    mock.module("src/libs/consensus/confirmationEstimate", () => ({
        estimateNextConfirmationBlock: async () => 101,
    }))
}

/**
 * Replaces the pool's insert for each test; `hashes` are the transactions
 * submission queued in the current test.
 */
export function captureQueued(mempool: object): { hashes: string[] } {
    const pool = mempool as { addTransactionWithLock: (tx: Transaction) => Promise<unknown> }
    const original = pool.addTransactionWithLock
    const queued = { hashes: [] as string[] }
    beforeEach(() => {
        queued.hashes = []
        pool.addTransactionWithLock = async (tx: Transaction) => {
            queued.hashes.push(tx.hash)
            return { confirmationBlock: 101 }
        }
    })
    afterEach(() => {
        pool.addTransactionWithLock = original
    })
    return queued
}
