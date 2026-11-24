/**
 * Mempool.receive gives each transaction of a batch its own verdict: the
 * ones judged valid are stored, whatever the verdict on the others.
 *
 * The transactions are signed by the real SDK signer. The validator pool
 * (on its inline path: no worker is started), the identity lookup and
 * validateTx are the real ones; only the chain and the database are replaced.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test"

import { installPoolStorageMocks } from "../mempool.fixtures"

const inserted = installPoolStorageMocks()

mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug: () => {}, info: () => {}, warn: () => {}, warning: () => {}, error: () => {}, only: () => {}, custom: () => {} },
}))
mock.module("src/libs/blockchain/validation/identityAdmission", () => ({
    checkIdentityAdmission: async () => ({ ok: true }),
}))

import { DemosTransactions } from "@kynesyslabs/demosdk/websdk"
import type { Transaction } from "@kynesyslabs/demosdk/types"
import { OS, PEER, chainIs, demos, onTheWire } from "./editBinding.fixtures"

const mempool = (await import("../mempool")).default

const transfer = async (dem: bigint): Promise<Transaction> =>
    onTheWire(await DemosTransactions.pay(PEER, dem * OS, demos))

const pending = (tx: Transaction) =>
    ({ ...tx, reference_block: 100, blockNumber: 100, status: "pending" }) as unknown as Transaction

beforeEach(() => {
    chainIs(true)
    inserted.length = 0
    ;(mempool as any).repo = { find: async () => [] }
})

describe("Mempool.receive on a batch", () => {
    it("gives each transaction its own verdict", async () => {
        const good = await transfer(5n)
        const bad = { ...(await transfer(6n)), signature: null } as unknown as Transaction
        await mempool.receive([pending(bad), pending(good)], false)
        expect(inserted.map(row => row.hash)).toEqual([good.hash])
    })

    it("stores a valid transaction received on its own", async () => {
        const tx = await transfer(6n)
        await mempool.receive([pending(tx)], false)
        expect(inserted.map(row => row.hash)).toEqual([tx.hash])
    })
})
