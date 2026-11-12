/**
 * Every door into the pool holds the launch feature gates: gossip, the
 * consensus merge and the node's own submissions (L2PS batches and hash
 * updates). Under `l2psGate` no L2PS type enters the pool, under
 * `tlsnDisabled` no TLSNotary request or store does; while the forks are
 * dormant both enter as before.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { installPoolStorageMocks, installPoolValidationMocks } from "./mempool.fixtures"
import { mockLogger } from "./testSupport/mockMempoolDeps"
import { DemosTransactions } from "@kynesyslabs/demosdk/websdk"
import { TLSNotaryService } from "@kynesyslabs/demosdk/tlsnotary/service"
import type { Transaction, ValidityData } from "@kynesyslabs/demosdk/types"
import { OS, PEER, chainIs, demos, handMade, onTheWire } from "./validation/editBinding.fixtures"
import { getSharedState } from "@/utilities/sharedState"
import { L2PS_GATE_REFUSAL } from "@/forks/l2psGate"
import { TLSN_DISABLED_REFUSAL } from "@/forks/tlsnDisabledGate"
import Mempool from "./mempool"

const inserted = installPoolStorageMocks()
mockLogger("src/utilities/logger")
installPoolValidationMocks()

const validity = (tx: Transaction): ValidityData =>
    ({ data: { transaction: tx, reference_block: 100 } }) as unknown as ValidityData
const row = (tx: Transaction) =>
    ({ ...tx, reference_block: 100, blockNumber: 100, status: "pending" }) as unknown as Transaction

const encrypted = async () =>
    onTheWire(await handMade("l2psEncryptedTx", { l2ps_uid: "net", encrypted_data: "x", tag: "t", original_hash: "ab".repeat(32) }))
const hashUpdate = async () =>
    onTheWire(await handMade("l2ps_hash_update", { l2ps_uid: "net", consolidated_hash: "cd".repeat(32), transaction_count: 1 }))
const batch = async () => onTheWire(await handMade("l2psBatch", { l2ps_uid: "net", batch_hash: "ef".repeat(32) }))
const tlsnService = () => {
    demos.connected = true
    return new TLSNotaryService(demos) as any
}
const request = async () => onTheWire(await tlsnService().createTlsnRequestTransaction("https://example.com", 8))
const store = async () => onTheWire(await tlsnService().createTlsnStoreTransaction("token-1", "proof", "onchain", 2n * OS, 8))
const pay = async () => onTheWire(await DemosTransactions.pay(PEER, 3n, demos))

function forks(l2psGate: number | null, tlsnDisabled: number | null) {
    chainIs(true, 0)
    const config = getSharedState.forkConfig as unknown as Record<string, { activationHeight: number | null }>
    config.l2psGate = { activationHeight: l2psGate }
    config.tlsnDisabled = { activationHeight: tlsnDisabled }
}

const pool = Mempool as any
const original = { repo: pool.repo, addWithLock: pool.addTransactionWithLock, exists: pool.checkTransactionByHash }
const lockedAdds: string[] = []

beforeEach(() => {
    inserted.length = 0
    lockedAdds.length = 0
    pool.repo = { find: async () => [] }
    pool.addTransactionWithLock = async (tx: Transaction) => (lockedAdds.push(tx.hash), { confirmationBlock: 101 })
})

afterEach(() => {
    pool.repo = original.repo
    pool.addTransactionWithLock = original.addWithLock
    pool.checkTransactionByHash = original.exists
})

describe("Mempool.ingestGossiped", () => {
    it("refuses an L2PS transaction under l2psGate", async () => {
        forks(0, null)
        const out = await Mempool.ingestGossiped(validity(await encrypted()))
        expect(out).toMatchObject({ accepted: false, reason: L2PS_GATE_REFUSAL })
        expect(lockedAdds).toEqual([])
    })

    it("refuses a TLSNotary request and store under tlsnDisabled", async () => {
        forks(null, 0)
        for (const tx of [await request(), await store()]) {
            const out = await Mempool.ingestGossiped(validity(tx))
            expect(out).toMatchObject({ accepted: false, reason: TLSN_DISABLED_REFUSAL })
        }
        expect(lockedAdds).toEqual([])
    })

    it("admits a TLSNotary request while the fork is dormant", async () => {
        forks(0, null)
        expect(await Mempool.ingestGossiped(validity(await request()))).toMatchObject({ accepted: true })
    })
})

describe("Mempool.receive", () => {
    it("drops L2PS and TLSNotary transactions from the merge and keeps the rest", async () => {
        forks(0, 0)
        const good = await pay()
        await Mempool.receive([row(await encrypted()), row(await request()), row(good), row(await store())], false)
        expect(inserted.map(r => r.hash)).toEqual([good.hash])
    })

    it("merges them as before while the forks are dormant", async () => {
        forks(null, null)
        const tx = await request()
        await Mempool.receive([row(tx)], false)
        expect(inserted.map(r => r.hash)).toEqual([tx.hash])
    })
})

describe("Mempool.addTransaction", () => {
    it("refuses the node's own L2PS batch and hash update under l2psGate", async () => {
        forks(0, null)
        pool.checkTransactionByHash = async () => {
            throw new Error("an L2PS transaction got past the gate")
        }
        for (const tx of [await batch(), await hashUpdate()]) {
            const out = await Mempool.addTransaction({ ...tx, reference_block: 100 })
            expect(out).toEqual({ confirmationBlock: null, error: L2PS_GATE_REFUSAL })
        }
    })

    it("refuses a TLSNotary request under tlsnDisabled", async () => {
        forks(null, 0)
        const out = await Mempool.addTransaction({ ...(await request()), reference_block: 100 })
        expect(out).toEqual({ confirmationBlock: null, error: TLSN_DISABLED_REFUSAL })
    })
})
