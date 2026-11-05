/**
 * The nonce at block apply. Before the `nonceIntegrity` fork apply never
 * compares a transaction's nonce with the account's, and a failed transaction
 * gives its nonce back, so a later nonce of the same block can apply while
 * the account stays behind it. Behind the fork the nonce must be the sender's
 * next one, a failure still spends it and pays its fee, and the nonce edit
 * itself is bound.
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
import { StorageProgram } from "@kynesyslabs/demosdk/storage"
import { Identities } from "@kynesyslabs/demosdk/abstraction"
import type { Transaction } from "@kynesyslabs/demosdk/types"
import { cloneDefaultForkConfig, type ForkConfigByName } from "@/forks/forkConfig"
import { declareNativeOperationKinds } from "@/libs/atomic-work/effectBoundary"
import { registerAtomicWorkProfile } from "@/libs/atomic-work/profile"
import { intentBytesHash } from "@/libs/atomic-work/workEnvelope"
import { computeWorkId } from "@/libs/atomic-work/workId"
import { getSharedState } from "@/utilities/sharedState"
import type { GCREntityCaches } from "./handleGCR"
import { OS, PEER, SENDER, VICTIM, demos, onTheWire, viaConfirm } from "@/libs/blockchain/validation/editBinding.fixtures"

const { default: HandleGCR } = await import("./handleGCR")

let caches: GCREntityCaches
let assigned: Map<string, Array<{ txHash: string }>>
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
/** The gas edit the SDK places right before the nonce edit. */
const gasOf = (tx: Transaction) => {
    const all = edits(tx)
    const gas = all[all.indexOf(nonceEdit(tx)) - 1]
    expect(gas).toMatchObject({ type: "balance", operation: "remove", account: SENDER })
    return BigInt(gas.amount)
}

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
    assigned = new Map()
    ;(HandleGCR as any).saveGCREditChanges = async (_e: unknown, _s: unknown, records: typeof assigned) => {
        assigned = records
    }
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

    it("charges a transaction that fails in the block its fee and nonce, and nothing else", async () => {
        const failing = await overdraft(8)

        const out = await HandleGCR.applyTransactions([failing], false)

        expect(out.failedTxs).toEqual([failing.hash])
        expect(out.nonceChargedTxs).toEqual([failing.hash])
        expect(nonceOf(SENDER)).toBe(8)
        expect(gasOf(failing)).toBe(OS)
        expect(balanceOf(SENDER)).toBe(100n * OS - gasOf(failing))
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
        expect(balanceOf(SENDER)).toBe(100n * OS - gasOf(failing) - 3n * OS - gasOf(next))
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

describe("the fee of a transaction that fails in a block", () => {
    beforeEach(() => forks(0))

    const storageWrite = async () =>
        onTheWire(
            await demos.storagePrograms.sign(
                StorageProgram.writeStorage("stor-" + "ab".repeat(20), { hello: "world" }, "json"),
            ),
        ) as Transaction

    it("charges a failed storage write its gas once, never its storage burn, and mints nothing", async () => {
        const write = await storageWrite()
        const burn = edits(write)[0]
        expect(burn).toMatchObject({ type: "balance", operation: "remove", account: SENDER })

        const out = await HandleGCR.applyTransactions([write], false)

        expect(out.failedTxs).toEqual([write.hash])
        expect(out.nonceChargedTxs).toEqual([write.hash])
        expect(nonceOf(SENDER)).toBe(8)
        // Before the restore the reversal of the burn refunded it a second time.
        expect(balanceOf(SENDER)).toBe(100n * OS - gasOf(write))
    })

    it("charges the gas a failed transaction left out of its edits", async () => {
        const write = await storageWrite()
        const gas = gasOf(write)
        const all = edits(write)
        all.splice(all.indexOf(nonceEdit(write)) - 1, 1)

        const out = await HandleGCR.applyTransactions([write], false)

        expect(out.nonceChargedTxs).toEqual([write.hash])
        expect(nonceOf(SENDER)).toBe(8)
        expect(balanceOf(SENDER)).toBe(100n * OS - gas)
    })

    it("charges a failed identity transaction, which carries no gas, its nonce only", async () => {
        const remove = onTheWire(
            await viaConfirm(() =>
                new Identities().removeXmIdentity(demos, {
                    chain: "evm",
                    subchain: "mainnet",
                    address: "0x" + "ee".repeat(20),
                } as never),
            ),
        ) as Transaction
        expect(remove.content.type).toBe("identity")

        const out = await HandleGCR.applyTransactions([remove], false)

        expect(out.failedTxs).toEqual([remove.hash])
        expect(out.nonceChargedTxs).toEqual([remove.hash])
        expect(nonceOf(SENDER)).toBe(8)
        expect(balanceOf(SENDER)).toBe(100n * OS)
    })

    it("spends the nonce alone when the account cannot pay the fee", async () => {
        (caches.accounts.get(SENDER) as any).balance = OS / 2n
        const failing = await transfer(8)

        const out = await HandleGCR.applyTransactions([failing], false)

        expect(out.failedTxs).toEqual([failing.hash])
        expect(out.nonceChargedTxs).toEqual([failing.hash])
        expect(nonceOf(SENDER)).toBe(8)
        expect(balanceOf(SENDER)).toBe(OS / 2n)
        expect(balanceOf(PEER)).toBe(0n)
    })

    it("charges the derived fee edits as well once gasFeeSeparation is active", async () => {
        const BURN = "0x" + "00".repeat(32)
        const TREASURY = "0x" + "f7".repeat(32)
        getSharedState.forkConfig.gasFeeSeparation.activationHeight = 0
        const savedDistribution = (getSharedState as any).feeDistribution
        ;(getSharedState as any).feeDistribution = {
            burnAddress: BURN,
            treasuryAddress: TREASURY,
            networkFee: { burnPct: 50, treasuryPct: 50 },
            additionalFee: { burnPct: 50, treasuryPct: 50 },
            specialOps: { burnPct: 50, rpcPct: 25, treasuryPct: 25 },
        }
        caches.accounts.set(BURN, { pubkey: BURN, balance: 0n, nonce: 0 } as any)
        caches.accounts.set(TREASURY, { pubkey: TREASURY, balance: 0n, nonce: 0 } as any)
        try {
            const failing = await overdraft(8)
            const networkFee = BigInt(failing.content.transaction_fee.network_fee as never)
            expect(networkFee).toBeGreaterThan(0n)

            const out = await HandleGCR.applyTransactions([failing], false)

            expect(out.nonceChargedTxs).toEqual([failing.hash])
            expect(nonceOf(SENDER)).toBe(8)
            expect(balanceOf(SENDER)).toBe(100n * OS - networkFee - gasOf(failing))
            expect(balanceOf(BURN) + balanceOf(TREASURY)).toBe(networkFee)
            expect(balanceOf(PEER)).toBe(0n)
        } finally {
            (getSharedState as any).feeDistribution = savedDistribution
        }
    })

    it("records a charged failure in the sender's assigned transactions, and a refused one nowhere", async () => {
        const failing = await overdraft(8)
        const refused = await transfer(10)

        await HandleGCR.applyTransactions([failing, refused], false)

        expect((assigned.get(SENDER) ?? []).map(r => r.txHash)).toEqual([failing.hash])
    })

    it("charges nothing for a transaction its forged-edit guard refuses, whose fee is unproven", async () => {
        getSharedState.forkConfig.nonceEnforcement.activationHeight = 0
        const tx = await transfer(8)
        edits(tx).find(e => e.type === "balance" && e.operation === "add")!.amount = String(2n * OS)

        const out = await HandleGCR.applyTransactions([tx], false)

        expect(out.failedTxs).toEqual([tx.hash])
        expect(out.nonceChargedTxs).toEqual([])
        expect(nonceOf(SENDER)).toBe(7)
        expect(balanceOf(SENDER)).toBe(100n * OS)
        expect(logged.some(m => m.includes("forged-edit guard"))).toBe(true)
    })

    it("leaves the forging and the syncing node on the same state", async () => {
        demos.getAddressNonce = async () => 8
        const write = await storageWrite()
        demos.getAddressNonce = originalNonce
        const block = [await overdraft(8), write, await transfer(10)]

        const forged = await HandleGCR.applyTransactions(block, false)
        const forgedState = structuredClone([...caches.accounts.entries()])

        caches = freshCaches()
        const synced = await HandleGCR.applyTransactions(block.map(tx => onTheWire(tx)), false)

        expect(synced).toEqual(forged)
        expect([...caches.accounts.entries()]).toEqual(forgedState)
        expect(forged.successfulTxs).toEqual([block[2].hash])
        expect(forged.nonceChargedTxs).toEqual([block[0].hash, block[1].hash])
    })
})

describe("the fee of a Work that fails in a block", () => {
    const PROFILE = "nonce-integrity-slot-v1"
    const DOMAINS = {
        workId: "nonce-work:v1:",
        authorization: "nonce-auth:v1:",
        operationReceipt: "nonce-op-receipt:v1:",
        workReceipt: "nonce-receipt:v1:",
    }
    const CLOCK = { height: 101, timestampSec: 1_800_000_000 }
    const operations = [{ operationId: "claim", kind: "resource-slot-cas", dependsOn: [] as string[], requiredRoles: [] as string[] }]

    beforeEach(() => {
        forks(0)
        getSharedState.forkConfig.atomicWork.activationHeight = 0
    })

    registerAtomicWorkProfile({
        name: PROFILE,
        operationGraph: operations.map(({ kind, ...o }) => ({ ...o, kinds: [kind] })),
        roles: [],
        domains: DOMAINS,
        verifyAuthorizations: () => {},
    })
    declareNativeOperationKinds()

    /** A Work claiming slot `k1`, built and signed by the SDK on nonce 8. */
    async function work(over: { expiresAt?: number; attemptClass?: string } = {}) {
        const intent: Record<string, unknown> = { profile: PROFILE, seed: "s1", operations }
        if (over.expiresAt !== undefined) intent.expiresAt = over.expiresAt
        const workId = computeWorkId(intent, DOMAINS.workId)
        const attempt: Record<string, unknown> = {
            type: "work-attempt",
            workId,
            attemptId: "s1-a1",
            canonicalBytesHash: intentBytesHash(intent),
        }
        if (over.attemptClass) attempt.attemptClass = over.attemptClass
        const slot = {
            type: "resource-slot-cas",
            resourceKey: "k1",
            expected: { state: "vacant", generation: 0 },
            transition: "settle",
            workId,
            conflictDigest: "c1",
        }
        const tx = onTheWire(
            await DemosTransactions.atomicWork(
                // A replay carries no effects of its own, only the attempt.
                { intent, authorizations: [], edits: over.attemptClass === "replay" ? [attempt] : [attempt, slot], transfers: [] } as never,
                demos,
            ),
        ) as Transaction
        expect(tx.content.nonce).toBe(8)
        return tx
    }

    const takeSlot = () =>
        caches.resourceSlots.set("k1", {
            state: "settled",
            generation: 0,
            workId: "w0",
            conflictDigest: "c0",
            receiptCommitment: "r0",
            resourceKey: "k1",
            txHash: "0x0",
            previous: null,
        } as any)

    it("charges a Work that rolled back its fee and nonce once, as a success", async () => {
        takeSlot()
        const tx = await work()

        const out = await HandleGCR.applyTransactions([tx], false, CLOCK)

        expect(out.successfulTxs).toEqual([tx.hash])
        expect(out.nonceChargedTxs).toEqual([])
        expect(nonceOf(SENDER)).toBe(8)
        expect(balanceOf(SENDER)).toBe(100n * OS - gasOf(tx))
        expect((caches.resourceSlots.get("k1") as any).workId).toBe("w0")
    })

    it("charges a Work refused in the block, its deadline gone, its fee and nonce", async () => {
        const tx = await work({ expiresAt: 1 })

        const out = await HandleGCR.applyTransactions([tx], false, CLOCK)

        expect(logged.some(m => m.includes(`${tx.hash} not applied: this Work expired`))).toBe(true)

        expect(out.failedTxs).toEqual([tx.hash])
        expect(out.nonceChargedTxs).toEqual([tx.hash])
        expect(nonceOf(SENDER)).toBe(8)
        expect(balanceOf(SENDER)).toBe(100n * OS - gasOf(tx))
    })

    it("charges a failed replay its nonce only: the Work it reads back already paid", async () => {
        const tx = await work({ attemptClass: "replay" })

        const out = await HandleGCR.applyTransactions([tx], false, CLOCK)

        expect(logged.some(m => m.includes(`${tx.hash} not applied (edit 0): replay of Work`))).toBe(true)

        expect(out.failedTxs).toEqual([tx.hash])
        expect(out.nonceChargedTxs).toEqual([tx.hash])
        expect(nonceOf(SENDER)).toBe(8)
        expect(balanceOf(SENDER)).toBe(100n * OS)
    })
})
