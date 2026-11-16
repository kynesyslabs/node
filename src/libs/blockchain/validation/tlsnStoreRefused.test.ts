/**
 * The TLSN table's hash covers a per-node `createdAt`, so a stored proof
 * would split the table hash across nodes. The table is written only by a
 * shipped `tlsnotary` edit, and under `editBinding` (block 0 on mainnet) the
 * shipped edits must equal the ones the SDK regenerates from the signed
 * body, which never include one. A `tlsn_store` therefore only pays its fee
 * and the table stays empty on every node.
 *
 * If a later SDK starts generating the store edit, the node would apply it
 * through the same comparison; these tests fail first, before the table can
 * diverge, and the store has to go behind its own fork.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"

let tip = 100
mock.module("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: {
        getLastBlockNumber: async () => tip,
        getExistingTransactionHashes: async () => new Set<string>(),
    },
}))
mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug: () => {}, info: () => {}, warning: () => {}, error: () => {}, only: () => {}, custom: () => {} },
}))

import { TLSNotaryService } from "@kynesyslabs/demosdk/tlsnotary/service"
import { GCRGeneration } from "@kynesyslabs/demosdk/websdk"
import type { Transaction } from "@kynesyslabs/demosdk/types"
import { getSharedState } from "@/utilities/sharedState"
import type { GCREntityCaches } from "@/libs/blockchain/gcr/handleGCR"
import { OS, SENDER, chainIs, demos, onTheWire } from "./editBinding.fixtures"
import { verifyAdmissionEdits } from "./editBinding"

const { default: HandleGCR } = await import("@/libs/blockchain/gcr/handleGCR")

async function tlsnStore(): Promise<Transaction> {
    demos.connected = true
    // The builder storeProof uses, without its broadcast.
    const service = new TLSNotaryService(demos) as any
    const tx: Transaction = await service.createTlsnStoreTransaction("token-1", "proof-bytes", "onchain", 2n * OS, 8)
    return onTheWire(tx)
}

/** The same signed store with the proof row a peer would have to add itself. */
async function tlsnStoreWithRow(): Promise<Transaction> {
    const tx = await tlsnStore()
    ;(tx.content.gcr_edits as unknown[]).push({
        type: "tlsnotary",
        operation: "store",
        account: SENDER,
        data: { tokenId: "token-1", domain: "example.com", proof: "proof-bytes", storageType: "onchain", timestamp: 1 },
        txhash: tx.hash,
        isRollback: false,
    })
    return tx
}

let caches: GCREntityCaches
const original = {
    prepareEntities: HandleGCR.prepareEntities,
    saveGCREditChanges: HandleGCR.saveGCREditChanges,
    bulkUpdateAssignedTxs: HandleGCR.bulkUpdateAssignedTxs,
}
const savedForks = getSharedState.forkConfig

beforeEach(() => {
    caches = {
        accounts: new Map([[SENDER, { pubkey: SENDER, balance: 100n * OS, nonce: 7 } as any]]),
        storagePrograms: new Map(),
        tlsNotaries: new Map(),
        atomicWorks: new Map(),
        resourceSlots: new Map(),
    }
    ;(HandleGCR as any).prepareEntities = async () => caches
    ;(HandleGCR as any).saveGCREditChanges = async () => {}
    ;(HandleGCR as any).bulkUpdateAssignedTxs = async () => {}
    chainIs(true, 0)
    tip = 100
})

afterEach(() => {
    getSharedState.forkConfig = savedForks
    Object.assign(HandleGCR, original)
})

describe("tlsn_store under editBinding", () => {
    it("regenerates no tlsnotary edit from the SDK-built body", async () => {
        const edits = await GCRGeneration.generate(await tlsnStore())
        expect(edits.map(e => e.type)).not.toContain("tlsnotary")
    })

    it("is refused at admission when it ships a proof row", async () => {
        const verdict = await verifyAdmissionEdits(await tlsnStoreWithRow())
        expect(verdict.ok).toBe(false)
    })

    it("fails at apply when it ships a proof row, and stores nothing", async () => {
        const tx = await tlsnStoreWithRow()

        const out = await HandleGCR.applyTransactions([tx], false)

        expect(out.failedTxs).toEqual([tx.hash])
        expect(caches.tlsNotaries.size).toBe(0)
    })
})
