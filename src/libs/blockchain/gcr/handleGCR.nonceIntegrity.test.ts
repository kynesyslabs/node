/**
 * The nonce at block apply. Before the `nonceIntegrity` fork apply never
 * compares a transaction's nonce with the account's, and a failed transaction
 * gives its nonce back, so a later nonce of the same block can apply while
 * the account stays behind it. Behind the fork the nonce must be the sender's
 * next one, a failure still spends it, and the nonce edit itself is bound.
 *
 * Every transaction is built and signed by the real SDK.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"

let tip = 100
const logged: string[] = []
mock.module("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: {
        getLastBlockNumber: async () => tip,
        getExistingTransactionHashes: async () => new Set<string>(),
    },
}))
mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: () => {},
        info: () => {},
        warning: () => {},
        error: (m: unknown) => logged.push(String(m)),
        only: () => {},
        custom: () => {},
    },
}))

import { DemosTransactions } from "@kynesyslabs/demosdk/websdk"
import type { Transaction } from "@kynesyslabs/demosdk/types"
import { cloneDefaultForkConfig, type ForkConfigByName } from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"
import type { GCREntityCaches } from "./handleGCR"
import { OS, PEER, SENDER, VICTIM, demos, onTheWire } from "@/libs/blockchain/validation/editBinding.fixtures"

const { default: HandleGCR } = await import("./handleGCR")

let caches: GCREntityCaches
const original = {
    prepareEntities: HandleGCR.prepareEntities,
    saveGCREditChanges: HandleGCR.saveGCREditChanges,
    bulkUpdateAssignedTxs: HandleGCR.bulkUpdateAssignedTxs,
}
const originalNonce = demos.getAddressNonce
let savedForks: ForkConfigByName
let savedProd: boolean

function freshCaches(): GCREntityCaches {
    const account = (pubkey: string, balance: bigint) => [pubkey, { pubkey, balance, nonce: 7 } as any] as const
    return {
        accounts: new Map([account(SENDER, 100n * OS), account(VICTIM, 5n * OS), account(PEER, 0n)]),
        storagePrograms: new Map(),
        tlsNotaries: new Map(),
        atomicWorks: new Map(),
        resourceSlots: new Map(),
    }
}

function forks(nonceIntegrity: number | null, editBinding: number | null = null) {
    getSharedState.forkConfig = cloneDefaultForkConfig()
    getSharedState.forkConfig.osDenomination.activationHeight = 0
    getSharedState.forkConfig.gasFeeSeparation.activationHeight = null
    getSharedState.forkConfig.editBinding.activationHeight = editBinding
    getSharedState.forkConfig.nonceIntegrity.activationHeight = nonceIntegrity
    getSharedState.lastBlockNumber = 100
    tip = 100
}

const balanceOf = (key: string) => (caches.accounts.get(key) as any).balance as bigint
const nonceOf = (key: string) => (caches.accounts.get(key) as any).nonce as number
const edits = (tx: Transaction) => tx.content.gcr_edits as unknown as Array<Record<string, any>>
const nonceEdit = (tx: Transaction) => edits(tx).find(e => e.type === "nonce")!

/** A native transfer signed by SENDER with `nonce`, as a peer receives it. */
async function pay(nonce: number, amount: bigint): Promise<Transaction> {
    demos.getAddressNonce = async () => nonce - 1
    try {
        const tx = onTheWire(await DemosTransactions.pay(PEER, amount, demos))
        expect(tx.content.nonce).toBe(nonce)
        return tx
    } finally {
        demos.getAddressNonce = originalNonce
    }
}

/** Fails at apply: SENDER holds 100 OS. */
const overdraft = (nonce: number) => pay(nonce, 1_000n * OS)
const transfer = (nonce: number) => pay(nonce, 3n * OS)

beforeEach(() => {
    savedForks = getSharedState.forkConfig
    savedProd = getSharedState.PROD
    // Outside PROD an overdraft is clamped to zero instead of failing.
    getSharedState.PROD = true
    logged.length = 0
    caches = freshCaches()
    ;(HandleGCR as any).prepareEntities = async () => caches
    ;(HandleGCR as any).saveGCREditChanges = async () => {}
    ;(HandleGCR as any).bulkUpdateAssignedTxs = async () => {}
})

afterEach(() => {
    getSharedState.forkConfig = savedForks
    getSharedState.PROD = savedProd
    demos.getAddressNonce = originalNonce
    Object.assign(HandleGCR, original)
})

describe("applyTransactions before the nonceIntegrity fork", () => {
    beforeEach(() => forks(null))

    it("gives a failed transaction's nonce back while a later nonce of the block applies", async () => {
        const failing = await overdraft(8)
        const next = await transfer(9)

        const out = await HandleGCR.applyTransactions([failing, next], false)

        expect(out).toEqual({
            successfulTxs: [next.hash],
            failedTxs: [failing.hash],
            skippedTxs: [],
            pending: undefined,
        })
        expect(Object.keys(out)).not.toContain("nonceChargedTxs")
        // The account is one behind the nonce that applied: nonce 8 is free again.
        expect(nonceOf(SENDER)).toBe(8)
        expect(balanceOf(PEER)).toBe(3n * OS)
    })

    it("applies a nonce that is not the sender's next one", async () => {
        const ahead = await transfer(20)

        const out = await HandleGCR.applyTransactions([ahead], false)

        expect(out.successfulTxs).toEqual([ahead.hash])
        expect(nonceOf(SENDER)).toBe(8)
    })

    it("stays dormant on tip H when it activates at H + 1", async () => {
        forks(101)
        const ahead = await transfer(20)

        const out = await HandleGCR.applyTransactions([ahead], false)

        expect(out.successfulTxs).toEqual([ahead.hash])
        expect(out.nonceChargedTxs).toBeUndefined()
    })
})

describe("applyTransactions behind the nonceIntegrity fork", () => {
    beforeEach(() => forks(0))

    it("applies the sender's next nonce", async () => {
        const tx = await transfer(8)

        const out = await HandleGCR.applyTransactions([tx], false)

        expect(out.successfulTxs).toEqual([tx.hash])
        expect(out.nonceChargedTxs).toEqual([])
        expect(nonceOf(SENDER)).toBe(8)
        expect(balanceOf(PEER)).toBe(3n * OS)
    })

    it("refuses a nonce above the next one, changes nothing and spends nothing", async () => {
        const ahead = await transfer(10)

        const out = await HandleGCR.applyTransactions([ahead], false)

        expect(out.failedTxs).toEqual([ahead.hash])
        expect(out.nonceChargedTxs).toEqual([])
        expect(nonceOf(SENDER)).toBe(7)
        expect(balanceOf(SENDER)).toBe(100n * OS)
        expect(logged.some(m => m.includes("Nonce mismatch: expected 8, got 10"))).toBe(true)
    })

    it("refuses a nonce the sender already spent", async () => {
        const stale = await transfer(7)

        const out = await HandleGCR.applyTransactions([stale], false)

        expect(out.failedTxs).toEqual([stale.hash])
        expect(nonceOf(SENDER)).toBe(7)
        expect(balanceOf(PEER)).toBe(0n)
    })

    it("spends the nonce of a transaction that fails in the block, and nothing else", async () => {
        const failing = await overdraft(8)

        const out = await HandleGCR.applyTransactions([failing], false)

        expect(out.failedTxs).toEqual([failing.hash])
        expect(out.nonceChargedTxs).toEqual([failing.hash])
        expect(nonceOf(SENDER)).toBe(8)
        expect(balanceOf(SENDER)).toBe(100n * OS)
        expect(balanceOf(PEER)).toBe(0n)
    })

    it("keeps the account on the nonce that applied after a failed one", async () => {
        const failing = await overdraft(8)
        const next = await transfer(9)

        const out = await HandleGCR.applyTransactions([failing, next], false)

        expect(out.successfulTxs).toEqual([next.hash])
        expect(out.failedTxs).toEqual([failing.hash])
        expect(out.nonceChargedTxs).toEqual([failing.hash])
        expect(nonceOf(SENDER)).toBe(9)
        expect(balanceOf(PEER)).toBe(3n * OS)
    })

    it("refuses the failed transaction replayed in a later block", async () => {
        const failing = await overdraft(8)
        await HandleGCR.applyTransactions([failing], false)

        const replay = await HandleGCR.applyTransactions([onTheWire(failing)], false)

        expect(replay.failedTxs).toEqual([failing.hash])
        expect(replay.nonceChargedTxs).toEqual([])
        expect(nonceOf(SENDER)).toBe(8)
    })

    it("refuses another transaction signed for the nonce a failed one spent", async () => {
        const failing = await overdraft(8)
        await HandleGCR.applyTransactions([failing], false)

        const reuse = await transfer(8)
        const out = await HandleGCR.applyTransactions([reuse], false)

        expect(out.failedTxs).toEqual([reuse.hash])
        expect(nonceOf(SENDER)).toBe(8)
        expect(balanceOf(PEER)).toBe(0n)
    })

    it("refuses the second of two transactions for one nonce in the same block", async () => {
        const first = await transfer(8)
        const second = await pay(8, 4n * OS)

        const out = await HandleGCR.applyTransactions([first, second], false)

        expect(out.successfulTxs).toHaveLength(1)
        expect(out.failedTxs).toHaveLength(1)
        expect(out.nonceChargedTxs).toEqual([])
        expect(nonceOf(SENDER)).toBe(8)
    })

    const forgeries: Array<[string, (tx: Transaction) => void]> = [
        ["bumps by more than one", tx => { nonceEdit(tx).amount = 1000 }],
        ["bumps another account", tx => { nonceEdit(tx).account = VICTIM }],
        ["ships a rollback flag", tx => { nonceEdit(tx).isRollback = true }],
        ["removes instead of adding", tx => { nonceEdit(tx).operation = "remove" }],
        ["is shipped twice", tx => { edits(tx).push({ ...nonceEdit(tx) }) }],
        ["is missing", tx => { tx.content.gcr_edits = edits(tx).filter(e => e.type !== "nonce") as never }],
        ["carries an unexpected field", tx => { nonceEdit(tx).extra = 1 }],
    ]

    for (const [name, forge] of forgeries) {
        it(`refuses a nonce edit that ${name}, before apply, without spending the nonce`, async () => {
            const tx = await transfer(8)
            forge(tx)

            const out = await HandleGCR.applyTransactions([tx], false)

            expect(out.failedTxs).toEqual([tx.hash])
            expect(out.nonceChargedTxs).toEqual([])
            expect(nonceOf(SENDER)).toBe(7)
            expect(nonceOf(VICTIM)).toBe(7)
            expect(balanceOf(PEER)).toBe(0n)
        })
    }

    it("does not judge a rollback, which replays what a block already accepted", async () => {
        const tx = await transfer(8)
        await HandleGCR.applyTransactions([tx], false)
        expect(nonceOf(SENDER)).toBe(8)

        const back = await HandleGCR.applyTransactions([onTheWire(tx)], true)

        expect(back.failedTxs).toEqual([])
        expect(back.nonceChargedTxs).toBeUndefined()
        expect(nonceOf(SENDER)).toBe(7)
    })

    it("binds from the block applied on tip H, which is block H + 1", async () => {
        forks(100)
        const ahead = await transfer(20)

        const out = await HandleGCR.applyTransactions([ahead], false)

        expect(out.failedTxs).toEqual([ahead.hash])
        expect(nonceOf(SENDER)).toBe(7)
    })
})
