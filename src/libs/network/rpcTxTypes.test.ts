/**
 * RPC intake accepts only the transaction types a client may author. A type
 * the node does not implement, or one only a node authors, is refused before
 * it reaches the pool, whatever the fork schedule: it is this node's own
 * admission policy. The SDK signer is the real one; the chain, the pool and
 * the gossip mesh are replaced.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"

mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: () => {},
        info: () => {},
        warning: () => {},
        warn: () => {},
        error: () => {},
        only: () => {},
        custom: () => {},
    },
}))
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

import { DemosTransactions } from "@kynesyslabs/demosdk/websdk"
import type { Transaction, ValidityData } from "@kynesyslabs/demosdk/types"
import Mempool from "src/libs/blockchain/mempool"
import { PEER, chainIs, demos, handMade, onTheWire } from "src/libs/blockchain/validation/editBinding.fixtures"

const { submitValidatedTx } = await import("./txSubmission")

const original = (Mempool as any).addTransactionWithLock
let queued: string[] = []

beforeEach(() => {
    queued = []
    ;(Mempool as any).addTransactionWithLock = async (tx: Transaction) => {
        queued.push(tx.hash)
        return { confirmationBlock: 101 }
    }
})

afterEach(() => {
    ;(Mempool as any).addTransactionWithLock = original
})

const envelope = (tx: Transaction) => ({ data: { transaction: tx, reference_block: 100 } }) as unknown as ValidityData

/** A node-only type a client signs itself, with the edits it chooses. */
async function nodeOnly(type: string, gcrEdits: unknown[] = []): Promise<Transaction> {
    const tx = onTheWire(await handMade(type, { senderId: "a", targetId: "b", message: "m", timestamp: 1 }))
    tx.content.gcr_edits = gcrEdits as never
    return tx
}

describe("RPC submission of a transaction type", () => {
    for (const editBinding of [null, 0]) {
        const label = editBinding === null ? "editBinding dormant" : "editBinding active"

        it(`refuses types the node does not implement (${label})`, async () => {
            chainIs(true, editBinding)
            for (const type of ["escrow", "contractDeploy", "tokenCreation", "ipfs", "madeUp"]) {
                const tx = onTheWire(await handMade(type, { anything: 1 }))
                const out = await submitValidatedTx(envelope(tx), tx)
                expect(out.ok).toBe(false)
                expect(out.error).toContain("is not accepted")
            }
            expect(queued).toEqual([])
        })

        it(`refuses node-only types, with or without edits (${label})`, async () => {
            chainIs(true, editBinding)
            for (const type of ["instantMessaging", "genesis", "l2psBatch"]) {
                for (const tx of [await nodeOnly(type), onTheWire(await handMade(type, { anything: 1 }))]) {
                    const out = await submitValidatedTx(envelope(tx), tx)
                    expect(out.ok).toBe(false)
                    expect(out.error).toContain("authored by nodes only")
                }
            }
            expect(queued).toEqual([])
        })

        it(`queues what the SDK builds for an implemented type (${label})`, async () => {
            chainIs(true, editBinding)
            const tx = onTheWire(await DemosTransactions.pay(PEER, 3n, demos))
            expect((await submitValidatedTx(envelope(tx), tx)).ok).toBe(true)
            expect(queued).toEqual([tx.hash])
        })
    }
})
