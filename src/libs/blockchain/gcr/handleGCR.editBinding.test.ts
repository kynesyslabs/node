/**
 * A block applies the edits a transaction ships as they are. Before the
 * `editBinding` fork that includes edits nobody derived from the signed body;
 * behind it, a transaction whose edits differ from the regenerated ones is
 * refused for every type, and nothing it carried is applied.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"

let tipReads = 0
let tip = 100
const logged: string[] = []
mock.module("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: {
        getLastBlockNumber: async () => {
            tipReads++
            return tip
        },
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
import { OS, PEER, SENDER, VICTIM, demos, handMade, onTheWire } from "@/libs/blockchain/validation/editBinding.fixtures"

const { default: HandleGCR } = await import("./handleGCR")

let caches: GCREntityCaches
const original = {
    prepareEntities: HandleGCR.prepareEntities,
    saveGCREditChanges: HandleGCR.saveGCREditChanges,
    bulkUpdateAssignedTxs: HandleGCR.bulkUpdateAssignedTxs,
}
let savedForks: ForkConfigByName

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

function forks(editBinding: number | null) {
    getSharedState.forkConfig = cloneDefaultForkConfig()
    getSharedState.forkConfig.osDenomination.activationHeight = 0
    getSharedState.forkConfig.nonceEnforcement.activationHeight = null
    getSharedState.forkConfig.gasFeeSeparation.activationHeight = null
    getSharedState.forkConfig.editBinding.activationHeight = editBinding
    getSharedState.lastBlockNumber = 100
    tip = 100
}

const balanceOf = (key: string) => (caches.accounts.get(key) as any).balance as bigint
const nonceOf = (key: string) => (caches.accounts.get(key) as any).nonce as number
const edits = (tx: Transaction) => tx.content.gcr_edits as unknown as Array<Record<string, any>>

async function legit(type = "contractCall"): Promise<Transaction> {
    return onTheWire(await handMade(type, { contractAddress: PEER, method: "get", args: [] }))
}

/** A transaction that also credits `VICTIM` with funds nobody paid for. */
async function mint(type = "contractCall"): Promise<Transaction> {
    const tx = await legit(type)
    edits(tx).push({ type: "balance", operation: "add", account: VICTIM, amount: String(1_000n * OS), isRollback: false, txhash: "" })
    return tx
}

/** An identity transaction the SDK could not have generated edits for. */
async function unregenerable(): Promise<Transaction> {
    const tx = await legit()
    tx.content.type = "identity" as never
    tx.content.data = ["identity", { method: "unheard_of_method" }] as never
    return tx
}

beforeEach(() => {
    savedForks = getSharedState.forkConfig
    tipReads = 0
    caches = freshCaches()
    ;(HandleGCR as any).prepareEntities = async () => caches
    ;(HandleGCR as any).saveGCREditChanges = async () => {}
    ;(HandleGCR as any).bulkUpdateAssignedTxs = async () => {}
})

afterEach(() => {
    getSharedState.forkConfig = savedForks
    Object.assign(HandleGCR, original)
})

describe("applyTransactions before the editBinding fork", () => {
    beforeEach(() => forks(null))

    it("applies the edits a transaction ships, forged or not", async () => {
        const forged = await mint()
        const honest = await legit()
        honest.hash = "11".repeat(32)

        const out = await HandleGCR.applyTransactions([forged, honest], false)

        expect(out.failedTxs).toEqual([])
        expect(out.successfulTxs).toEqual([forged.hash, honest.hash])
        expect(balanceOf(VICTIM)).toBe(1_005n * OS)
    })

    it("applies a transaction whose edits cannot be regenerated", async () => {
        const tx = await unregenerable()

        const out = await HandleGCR.applyTransactions([tx], false)

        expect(out.failedTxs).toEqual([])
        expect(out.successfulTxs).toEqual([tx.hash])
    })
})

describe("applyTransactions behind the editBinding fork", () => {
    beforeEach(() => forks(0))

    it("refuses a transaction carrying a credit nobody derived and applies none of it", async () => {
        const forged = await mint()

        const out = await HandleGCR.applyTransactions([forged], false)

        expect(out.failedTxs).toEqual([forged.hash])
        expect(out.successfulTxs).toEqual([])
        expect(balanceOf(VICTIM)).toBe(5n * OS)
        expect(balanceOf(SENDER)).toBe(100n * OS)
        expect(nonceOf(SENDER)).toBe(7)
    })

    it("refuses a transaction whose edits cannot be regenerated", async () => {
        const tx = await unregenerable()

        const out = await HandleGCR.applyTransactions([tx], false)

        expect(out.failedTxs).toEqual([tx.hash])
        expect(nonceOf(SENDER)).toBe(7)
    })

    it("applies the honest transactions of the same block, and reports the refused one in arrival order", async () => {
        const a = await legit()
        a.hash = "aa".repeat(32)
        const forged = await mint()
        forged.hash = "bb".repeat(32)
        const b = await legit()
        b.hash = "cc".repeat(32)

        const out = await HandleGCR.applyTransactions([a, forged, b], false)

        expect(out.successfulTxs.sort()).toEqual([a.hash, b.hash].sort())
        expect(out.failedTxs).toEqual([forged.hash])
        expect(balanceOf(VICTIM)).toBe(5n * OS)
        expect(nonceOf(SENDER)).toBe(9)
    })

    it("refuses a forged nonce bump on another account", async () => {
        const tx = await legit()
        edits(tx).push({ type: "nonce", operation: "add", account: VICTIM, amount: 1000, isRollback: false, txhash: "" })

        const out = await HandleGCR.applyTransactions([tx], false)

        expect(out.failedTxs).toEqual([tx.hash])
        expect(nonceOf(VICTIM)).toBe(7)
    })

    it("refuses the forged edit on a type that applies only its universal edits", async () => {
        const forged = await mint("storage")
        const out = await HandleGCR.applyTransactions([forged], false)

        expect(out.failedTxs).toEqual([forged.hash])
        expect(balanceOf(VICTIM)).toBe(5n * OS)
    })

    it("lets a type that applies only its universal edits through when its edits are the derived ones", async () => {
        const honest = await legit("storage")
        const out = await HandleGCR.applyTransactions([honest], false)

        expect(out.failedTxs).toEqual([])
        expect(out.successfulTxs).toEqual([honest.hash])
        expect(nonceOf(SENDER)).toBe(8)
    })

    it("applies a native transfer as signed", async () => {
        const tx = onTheWire(await DemosTransactions.pay(PEER, 3n * OS, demos))
        const out = await HandleGCR.applyTransactions([tx], false)

        expect(out.failedTxs).toEqual([])
        expect(balanceOf(PEER)).toBe(3n * OS)
        expect(balanceOf(SENDER)).toBe(100n * OS - 3n * OS - OS)
    })

    it("refuses a native transfer whose fee is shipped as a DEM number, which would apply as 1 OS", async () => {
        const tx = onTheWire(await DemosTransactions.pay(PEER, 3n * OS, demos))
        const gas = edits(tx).filter(e => e.type === "balance" && e.operation === "remove")[1]
        expect(gas.amount).toBe("1000000000")
        gas.amount = 1

        const out = await HandleGCR.applyTransactions([tx], false)

        expect(out.failedTxs).toEqual([tx.hash])
        expect(balanceOf(SENDER)).toBe(100n * OS)
    })

    it("does not judge a rollback, which replays what a block already accepted", async () => {
        const tx = await legit()
        await HandleGCR.applyTransactions([tx], false)
        expect(nonceOf(SENDER)).toBe(8)
        tipReads = 0

        const out = await HandleGCR.applyTransactions([tx], true)

        expect(out.failedTxs).toEqual([])
        expect(nonceOf(SENDER)).toBe(7)
        expect(balanceOf(SENDER)).toBe(100n * OS)
        expect(tipReads).toBe(0)
    })

    it("judges nothing on an empty block", async () => {
        const out = await HandleGCR.applyTransactions([], false)
        expect(out).toEqual({ successfulTxs: [], failedTxs: [], skippedTxs: [] })
        expect(tipReads).toBe(0)
    })
})

describe("the shipped-edit check inside apply, under nonceEnforcement", () => {
    const reordered = async () => {
        const tx = onTheWire(await DemosTransactions.pay(PEER, 3n * OS, demos))
        tx.content.gcr_edits = edits(tx).map(e => {
            const swapped: Record<string, unknown> = {}
            for (const k of Object.keys(e).reverse()) swapped[k] = e[k]
            return swapped
        }) as never
        return tx
    }

    it("applies a native transfer whose edit keys were written in another order once edits are bound", async () => {
        forks(0)
        getSharedState.forkConfig.nonceEnforcement.activationHeight = 0
        const tx = await reordered()

        const out = await HandleGCR.applyTransactions([tx], false)

        expect(out.failedTxs).toEqual([])
        expect(balanceOf(PEER)).toBe(3n * OS)
    })

    it("keeps refusing it before the fork, as before", async () => {
        forks(null)
        getSharedState.forkConfig.nonceEnforcement.activationHeight = 0
        const tx = await reordered()

        const out = await HandleGCR.applyTransactions([tx], false)

        expect(out.failedTxs).toEqual([tx.hash])
        expect(balanceOf(PEER)).toBe(0n)
    })

    it("still refuses a forged native transfer under both forks", async () => {
        forks(0)
        getSharedState.forkConfig.nonceEnforcement.activationHeight = 0
        const tx = await reordered()
        edits(tx).push({ type: "balance", operation: "add", account: VICTIM, amount: String(1_000n * OS), isRollback: false, txhash: "" })

        const out = await HandleGCR.applyTransactions([tx], false)

        expect(out.failedTxs).toEqual([tx.hash])
        expect(balanceOf(VICTIM)).toBe(5n * OS)
    })
})

describe("the editBinding fork height", () => {
    it("binds from the block applied on tip H, which is block H + 1, judged from the chain tip", async () => {
        forks(150)
        // The in-memory height says the opposite on purpose: it is not consulted.
        tip = 149
        getSharedState.lastBlockNumber = 1_000
        const early = await HandleGCR.applyTransactions([await mint()], false)
        expect(early.failedTxs).toEqual([])
        expect(balanceOf(VICTIM)).toBe(1_005n * OS)

        caches = freshCaches()
        tip = 150
        getSharedState.lastBlockNumber = 0
        const forged = await mint()
        const late = await HandleGCR.applyTransactions([forged], false)
        expect(late.failedTxs).toEqual([forged.hash])
        expect(balanceOf(VICTIM)).toBe(5n * OS)
    })

    it("names the block and the transaction when it refuses one", async () => {
        forks(0)
        logged.length = 0
        const forged = await mint()

        await HandleGCR.applyTransactions([forged], false, { height: 101, timestampSec: 1 })

        expect(logged.some(m => m.includes(`Refusing tx ${forged.hash} of block 101`))).toBe(true)
    })
})
