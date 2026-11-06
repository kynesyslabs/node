/**
 * Both doors into the pool judge a transaction's type. Gossip carries only
 * what a client may author, whatever the fork schedule, since node-authored
 * transactions travel through the consensus merge. The merge refuses a type
 * the node does not implement under `txTypeAllowList`, and admits it as
 * before while the fork is dormant.
 */

import { beforeEach, describe, expect, it } from "bun:test"

import { installPoolStorageMocks, installPoolValidationMocks } from "./mempool.fixtures"
import { mockLogger } from "./testSupport/mockMempoolDeps"
import { DemosTransactions } from "@kynesyslabs/demosdk/websdk"
import type { Transaction, ValidityData } from "@kynesyslabs/demosdk/types"
import { PEER, chainIs, demos, handMade, onTheWire } from "./validation/editBinding.fixtures"
import { getSharedState } from "@/utilities/sharedState"
import Mempool from "./mempool"

const inserted = installPoolStorageMocks()
mockLogger("src/utilities/logger")
installPoolValidationMocks()

const validity = (tx: Transaction): ValidityData =>
    ({ data: { transaction: tx, reference_block: 100 } }) as unknown as ValidityData
const row = (tx: Transaction) =>
    ({ ...tx, reference_block: 100, blockNumber: 100, status: "pending" }) as unknown as Transaction

/** A message signed by SENDER as the signalling server builds one: no edits. */
const freeMessage = async (timestamp: number) => {
    const tx = onTheWire(await handMade("instantMessaging", { senderId: "a", targetId: "b", message: "m", timestamp }))
    tx.content.gcr_edits = []
    return tx
}
const escrow = async () => onTheWire(await handMade("escrow", { platform: "github", username: "u", amount: "5", operation: "deposit" }))
const pay = async () => onTheWire(await DemosTransactions.pay(PEER, 3n, demos))

/** txTypeAllowList at `height`, instantMessagingBinding at `messageBinding`. */
function allowList(height: number | null, messageBinding: number | null = null) {
    chainIs(true, 0)
    const config = getSharedState.forkConfig as unknown as Record<string, { activationHeight: number | null }>
    config.txTypeAllowList = { activationHeight: height }
    config.instantMessagingBinding = { activationHeight: messageBinding }
}

beforeEach(() => {
    inserted.length = 0
    const pool = Mempool as any
    pool.repo = { find: async () => [] }
    pool.addTransactionWithLock = async () => ({ confirmationBlock: 101 })
})

describe("Mempool.ingestGossiped", () => {
    for (const height of [null, 0]) {
        const label = height === null ? "fork dormant" : "fork active"

        it(`refuses a type the node does not implement (${label})`, async () => {
            allowList(height)
            const out = await Mempool.ingestGossiped(validity(await escrow()))
            expect(out.accepted).toBe(false)
            expect(out.reason).toContain("is not accepted")
        })

        it(`refuses a node-only type, which never travels as gossip (${label})`, async () => {
            allowList(height)
            const out = await Mempool.ingestGossiped(validity(await freeMessage(1)))
            expect(out.accepted).toBe(false)
            expect(out.reason).toContain("authored by nodes only")
        })

        it(`admits an implemented type (${label})`, async () => {
            allowList(height)
            expect(await Mempool.ingestGossiped(validity(await pay()))).toMatchObject({ accepted: true })
        })
    }
})

describe("Mempool.receive", () => {
    it("refuses a type the node does not implement once the fork is active", async () => {
        allowList(0)
        const bad = await escrow()
        const good = await pay()
        await Mempool.receive([row(bad), row(good)], false)
        expect(inserted.map(r => r.hash)).toEqual([good.hash])
    })

    it("admits it as before while the fork is dormant", async () => {
        allowList(null)
        const bad = await escrow()
        await Mempool.receive([row(bad)], false)
        expect(inserted.map(r => r.hash)).toEqual([bad.hash])
    })
})

