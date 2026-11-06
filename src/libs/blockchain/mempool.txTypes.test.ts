/**
 * Both doors into the pool judge a transaction's type. Gossip carries only
 * what a client may author, whatever the fork schedule, since node-authored
 * transactions travel through the consensus merge. The merge refuses a type
 * the node does not implement under `txTypeAllowList`, and admits it as
 * before while the fork is dormant.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test"

import { installPoolStorageMocks } from "./mempool.fixtures"

const inserted = installPoolStorageMocks()

mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: () => {},
        info: () => {},
        warning: () => {},
        error: () => {},
        only: () => {},
        custom: () => {},
    },
}))
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

import { DemosTransactions } from "@kynesyslabs/demosdk/websdk"
import type { Transaction, ValidityData } from "@kynesyslabs/demosdk/types"
import Mempool from "./mempool"
import { PEER, chainIs, demos, handMade, onTheWire } from "./validation/editBinding.fixtures"
import { getSharedState } from "@/utilities/sharedState"

const validity = (tx: Transaction): ValidityData =>
    ({ data: { transaction: tx, reference_block: 100 } }) as unknown as ValidityData
const row = (tx: Transaction) =>
    ({ ...tx, reference_block: 100, blockNumber: 100, status: "pending" }) as unknown as Transaction

const escrow = async () => onTheWire(await handMade("escrow", { platform: "github", username: "u", amount: "5", operation: "deposit" }))
const pay = async () => onTheWire(await DemosTransactions.pay(PEER, 3n, demos))

function allowList(height: number | null) {
    chainIs(true, 0)
    ;(getSharedState.forkConfig as any).txTypeAllowList = { activationHeight: height }
}

beforeEach(() => {
    inserted.length = 0
    ;(Mempool as any).repo = { find: async () => [] }
    ;(Mempool as any).addTransactionWithLock = async () => ({ confirmationBlock: 101 })
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
            const message = onTheWire(await handMade("instantMessaging", { senderId: "a", targetId: "b", message: "m", timestamp: 1 }))
            message.content.gcr_edits = []
            const out = await Mempool.ingestGossiped(validity(message))
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
