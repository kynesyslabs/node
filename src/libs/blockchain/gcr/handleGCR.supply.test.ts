/**
 * Total supply across the block apply of plain native transfers, each built
 * and signed by the real SDK `pay` builder and sent through a JSON round trip
 * as a peer receives it.
 *
 * Under `gasFeeSeparation` the fee edits split the fee between burn, treasury
 * and the rpc share, so every debit has a credit. The SDK still ships the flat
 * gas edit of the lump-sum model, a debit nothing credits; applied on top of
 * the fee edits it charged the fee twice and removed 1 DEM of supply per
 * transfer. Behind `feeBinding` the block leaves that gas edit out on every
 * path that applies a block: forging, syncing a served block, rolling it back
 * and charging a transaction that fails in it.
 *
 * Every other type is charged its gas edit, not `transaction_fee`. Behind the
 * same forks the block keeps that debit and credits it as a network fee is
 * credited, split between burn and treasury, on the same paths.
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
    default: {
        debug: () => {},
        info: () => {},
        warning: () => {},
        error: () => {},
        only: () => {},
        custom: () => {},
    },
}))

import { DemosTransactions } from "@kynesyslabs/demosdk/websdk"
import type { Transaction } from "@kynesyslabs/demosdk/types"
import { cloneDefaultForkConfig, type ForkConfigByName } from "@/forks/forkConfig"
import { declareNativeOperationKinds } from "@/libs/atomic-work/effectBoundary"
import { registerAtomicWorkProfile } from "@/libs/atomic-work/profile"
import { intentBytesHash } from "@/libs/atomic-work/workEnvelope"
import { computeWorkId } from "@/libs/atomic-work/workId"
import { getSharedState } from "@/utilities/sharedState"
import type { GCREntityCaches } from "./handleGCR"
import { OS, PEER, SENDER, VICTIM, demos, handMade, onTheWire } from "@/libs/blockchain/validation/editBinding.fixtures"

const { default: HandleGCR, withDerivedFeeEdits } = await import("./handleGCR")

const TREASURY = "0x" + "f7".repeat(32)
const BURN = "0x" + "00".repeat(32)
const FEE = 2n * OS // network_fee 1 DEM + rpc_fee 1 DEM, the mainnet sheet

let caches: GCREntityCaches
const original = {
    prepareEntities: HandleGCR.prepareEntities,
    saveGCREditChanges: HandleGCR.saveGCREditChanges,
    bulkUpdateAssignedTxs: HandleGCR.bulkUpdateAssignedTxs,
}
const savedState = {
    forkConfig: getSharedState.forkConfig,
    feeDistribution: getSharedState.feeDistribution,
    networkFee: getSharedState.networkFee,
    rpcFee: getSharedState.rpcFee,
    additionalFee: getSharedState.additionalFee,
    lastBlockNumber: getSharedState.lastBlockNumber,
}
const savedSdk = {
    params: demos._getNetworkParametersCached,
    nonce: demos.getAddressNonce,
}

function freshCaches(senderBalance: bigint): GCREntityCaches {
    const row = (pubkey: string, balance: bigint, nonce = 0) => [pubkey, { pubkey, balance, nonce } as any] as const
    return {
        accounts: new Map([
            row(SENDER, senderBalance, 7),
            row(PEER, 0n),
            row(VICTIM, 0n),
            row(TREASURY, 0n),
            row(BURN, 0n),
        ]),
        storagePrograms: new Map(),
        tlsNotaries: new Map(),
        atomicWorks: new Map(),
        resourceSlots: new Map(),
    }
}

/** The safety forks a mainnet genesis sets at 0, with the fee forks chosen. */
function forks(rules: { gasFee: boolean; fee: boolean }) {
    const config = cloneDefaultForkConfig() as ForkConfigByName & Record<string, { activationHeight: number | null }>
    for (const name of ["osDenomination", "editBinding", "nonceIntegrity", "nativeSendBinding", "canonicalAddresses"]) {
        config[name] = { ...config[name], activationHeight: 0 }
    }
    config.nonceEnforcement.activationHeight = null
    config.gasFeeSeparation.activationHeight = rules.gasFee ? 0 : null
    config.feeBinding = { activationHeight: rules.fee ? 0 : null }
    getSharedState.forkConfig = config
    getSharedState.lastBlockNumber = 100
    tip = 100
}

const balanceOf = (key: string) => (caches.accounts.get(key) as any).balance as bigint
const nonceOf = (key: string) => (caches.accounts.get(key) as any).nonce as number
const supply = () => [...caches.accounts.values()].reduce((sum, row: any) => sum + BigInt(row.balance), 0n)
const balances = () => new Map([...caches.accounts].map(([key, row]: [string, any]) => [key, BigInt(row.balance)]))

/** Signed transfers from SENDER with nonces 8, 9, ..., as a peer receives them. */
async function transfers(payments: Array<[string, bigint]>): Promise<Transaction[]> {
    const out: Transaction[] = []
    for (const [i, [to, amount]] of payments.entries()) {
        demos.getAddressNonce = async () => 7 + i
        out.push(onTheWire(await DemosTransactions.pay(to, amount, demos)))
    }
    return out
}

const CLOCK = { height: 101, timestampSec: 1_800_000_000 }
const block = (txs: Transaction[]) => HandleGCR.applyTransactions(txs, false, CLOCK)

beforeEach(() => {
    caches = freshCaches(100n * OS)
    ;(HandleGCR as any).prepareEntities = async () => caches
    ;(HandleGCR as any).saveGCREditChanges = async () => {}
    ;(HandleGCR as any).bulkUpdateAssignedTxs = async () => {}
    getSharedState.feeDistribution = {
        burnAddress: BURN,
        treasuryAddress: TREASURY,
        networkFee: { burnPct: 50, treasuryPct: 50 },
        additionalFee: { burnPct: 25, treasuryPct: 75 },
        specialOps: { burnPct: 25, rpcPct: 50, treasuryPct: 25 },
    }
    getSharedState.networkFee = 1
    getSharedState.rpcFee = 1
    getSharedState.additionalFee = 0
    demos._getNetworkParametersCached = async () => ({ networkFee: 1, rpcFee: 1 })
})

afterEach(() => {
    Object.assign(getSharedState, savedState)
    Object.assign(HandleGCR, original)
    demos._getNetworkParametersCached = savedSdk.params
    demos.getAddressNonce = savedSdk.nonce
})

describe("native transfers under gasFeeSeparation and feeBinding", () => {
    beforeEach(() => forks({ gasFee: true, fee: true }))

    it("ships the SDK gas edit, which the block does not apply", async () => {
        const [tx] = await transfers([[PEER, 3n * OS]])
        const signed = tx.content.gcr_edits
        const gas = signed[signed.length - 2] as any
        expect(gas).toMatchObject({ type: "balance", operation: "remove", account: SENDER })

        const applied = withDerivedFeeEdits(tx).content.gcr_edits
        expect(applied.slice(-3)).toEqual([signed[0], signed[1], signed[signed.length - 1]])
        expect(tx.content.gcr_edits).toEqual(signed)
    })

    it("conserves total supply: the sender pays amount plus fee, and both are credited", async () => {
        const before = supply()
        const txs = await transfers([
            [PEER, 3n * OS],
            [VICTIM, 1n],
            [PEER, 7n * OS],
        ])

        const out = await block(txs)

        expect(out.failedTxs).toEqual([])
        expect(out.successfulTxs).toEqual(txs.map(t => t.hash))
        expect(supply()).toBe(before)
        expect(balanceOf(SENDER)).toBe(100n * OS - (10n * OS + 1n) - 3n * FEE)
        expect(balanceOf(PEER)).toBe(10n * OS)
        expect(balanceOf(VICTIM)).toBe(1n)
        // network_fee 50/50 burn and treasury; the rpc share has no operator
        // named, so it folds into treasury.
        expect(balanceOf(BURN)).toBe(3n * (OS / 2n))
        expect(balanceOf(TREASURY)).toBe(3n * (OS / 2n + OS))
        expect(nonceOf(SENDER)).toBe(10)
    })

    it("applies a served block the same on a syncing node", async () => {
        const [tx] = await transfers([[PEER, 3n * OS]])
        await block([tx])
        const producer = balances()

        caches = freshCaches(100n * OS)
        const out = await block([onTheWire(tx)])
        expect(out.failedTxs).toEqual([])
        expect(balances()).toEqual(producer)
    })

    it("leaves the gas edit out of a row stored with its fee edits in front", async () => {
        const [tx] = await transfers([[PEER, 3n * OS]])
        const applied = withDerivedFeeEdits(onTheWire(tx)).content.gcr_edits
        const storedRow = onTheWire(tx)
        storedRow.content.gcr_edits = [...applied.slice(0, -3), ...storedRow.content.gcr_edits]

        expect(withDerivedFeeEdits(storedRow).content.gcr_edits).toEqual(applied)
    })

    it("restores every balance when the block is rolled back", async () => {
        const start = balances()
        const txs = await transfers([
            [PEER, 3n * OS],
            [VICTIM, 2n * OS],
        ])
        await block(txs)

        const out = await HandleGCR.applyTransactions([...txs].reverse(), true)

        expect(out.failedTxs).toEqual([])
        expect(balances()).toEqual(start)
    })

    it("charges a transfer that fails in the block its fee only, and conserves supply", async () => {
        caches = freshCaches(10n * OS)
        const before = supply()
        const [tx] = await transfers([[PEER, 50n * OS]])

        const out = await block([tx])

        expect(out.failedTxs).toEqual([tx.hash])
        expect(supply()).toBe(before)
        expect(balanceOf(SENDER)).toBe(10n * OS - FEE)
        expect(balanceOf(PEER)).toBe(0n)
        expect(nonceOf(SENDER)).toBe(8)
    })
})

describe("chains that keep the earlier charge, so their history replays as applied", () => {
    it("still applies the gas edit under gasFeeSeparation without feeBinding", async () => {
        forks({ gasFee: true, fee: false })
        const before = supply()
        const [tx] = await transfers([[PEER, 3n * OS]])

        await block([tx])

        expect(balanceOf(SENDER)).toBe(100n * OS - 3n * OS - FEE - OS)
        expect(supply()).toBe(before - OS)
    })

    it("charges only the gas edit, credited to no account, without gasFeeSeparation", async () => {
        forks({ gasFee: false, fee: true })
        const before = supply()
        const [tx] = await transfers([[PEER, 3n * OS]])

        await block([tx])

        expect(balanceOf(SENDER)).toBe(100n * OS - 3n * OS - OS)
        expect(balanceOf(BURN) + balanceOf(TREASURY)).toBe(0n)
        expect(supply()).toBe(before - OS)
    })
})

const PROFILE = "supply-slot-v1"
const DOMAINS = {
    workId: "supply-work:v1:",
    authorization: "supply-auth:v1:",
    operationReceipt: "supply-op-receipt:v1:",
    workReceipt: "supply-receipt:v1:",
}
const operations = [{ operationId: "claim", kind: "resource-slot-cas", dependsOn: [] as string[], requiredRoles: [] as string[] }]
registerAtomicWorkProfile({
    name: PROFILE,
    operationGraph: operations.map(({ kind, ...o }) => ({ ...o, kinds: [kind] })),
    roles: [],
    domains: DOMAINS,
    verifyAuthorizations: () => {},
})
declareNativeOperationKinds()

/** A web2Request from SENDER on nonce 8: the gas and the nonce are all it applies. */
async function web2(): Promise<Transaction> {
    return onTheWire(await handMade("web2Request", { url: "https://example.com", method: "GET" }))
}

/** A Work claiming slot `k1`, built and signed by the SDK on nonce `nonce`. */
async function work(nonce: number, over: { expiresAt?: number } = {}): Promise<Transaction> {
    const intent: Record<string, unknown> = { profile: PROFILE, seed: "s1", operations }
    if (over.expiresAt !== undefined) intent.expiresAt = over.expiresAt
    const workId = computeWorkId(intent, DOMAINS.workId)
    const attempt = { type: "work-attempt", workId, attemptId: "s1-a1", canonicalBytesHash: intentBytesHash(intent) }
    const slot = {
        type: "resource-slot-cas",
        resourceKey: "k1",
        expected: { state: "vacant", generation: 0 },
        transition: "settle",
        workId,
        conflictDigest: "c1",
    }
    demos.getAddressNonce = async () => nonce - 1
    const tx = onTheWire(
        await DemosTransactions.atomicWork({ intent, authorizations: [], edits: [attempt, slot], transfers: [] } as never, demos),
    ) as Transaction
    expect(tx.content.nonce).toBe(nonce)
    return tx
}

const gasOf = (tx: Transaction) => {
    const edits = tx.content.gcr_edits as any[]
    const gas = edits[edits.length - 2]
    expect(gas).toMatchObject({ type: "balance", operation: "remove", account: SENDER })
    return BigInt(gas.amount)
}

describe("non-native transactions under gasFeeSeparation and feeBinding", () => {
    beforeEach(() => {
        forks({ gasFee: true, fee: true })
        // The forged-edit guard runs, so a Work's applied edits are compared
        // with the ones regenerated from its signed body.
        getSharedState.forkConfig.nonceEnforcement.activationHeight = 0
        getSharedState.forkConfig.atomicWork.activationHeight = 0
    })

    it("keeps the signed gas edit and credits it right after, as a network fee", async () => {
        const tx = await web2()
        const signed = structuredClone(tx.content.gcr_edits)

        const applied = withDerivedFeeEdits(tx).content.gcr_edits as any[]

        expect(gasOf(tx)).toBe(OS)
        expect(applied).toEqual([
            ...signed.slice(0, -1),
            expect.objectContaining({ type: "balance", operation: "add", account: BURN, amount: Number(OS / 2n) }),
            expect.objectContaining({ type: "balance", operation: "add", account: TREASURY, amount: Number(OS / 2n) }),
            signed[signed.length - 1],
        ])
        expect(tx.content.gcr_edits).toEqual(signed)
        const again = withDerivedFeeEdits(withDerivedFeeEdits(tx))
        expect(again.content.gcr_edits).toEqual(applied)
    })

    it("conserves total supply: the sender pays each gas, and burn and treasury receive it", async () => {
        const before = supply()
        const txs = [await web2(), await work(9)]

        const out = await block(txs)

        expect(out.failedTxs).toEqual([])
        expect(out.successfulTxs).toEqual(txs.map(t => t.hash))
        expect(supply()).toBe(before)
        expect(balanceOf(SENDER)).toBe(100n * OS - 2n * OS)
        expect(balanceOf(BURN)).toBe(OS)
        expect(balanceOf(TREASURY)).toBe(OS)
        expect(nonceOf(SENDER)).toBe(9)
        expect((caches.resourceSlots.get("k1") as any)?.state).toBe("settled")
    })

    it("applies a served block the same on a syncing node", async () => {
        const txs = [await web2(), await work(9)]
        await block(txs)
        const producer = balances()

        caches = freshCaches(100n * OS)
        const out = await block(txs.map(tx => onTheWire(tx)))

        expect(out.failedTxs).toEqual([])
        expect(balances()).toEqual(producer)
    })

    it("restores every balance when the block is rolled back", async () => {
        const start = balances()
        const txs = [await web2()]
        await block(txs)

        const out = await HandleGCR.applyTransactions(txs, true)

        expect(out.failedTxs).toEqual([])
        expect(balances()).toEqual(start)
    })

    it("charges a Work that fails in the block its gas, credited, and conserves supply", async () => {
        const before = supply()
        const tx = await work(8, { expiresAt: 1 })

        const out = await block([tx])

        expect(out.failedTxs).toEqual([tx.hash])
        expect(out.nonceChargedTxs).toEqual([tx.hash])
        expect(supply()).toBe(before)
        expect(balanceOf(SENDER)).toBe(100n * OS - OS)
        expect(balanceOf(BURN) + balanceOf(TREASURY)).toBe(OS)
        expect(nonceOf(SENDER)).toBe(8)
    })
})

describe("non-native transactions on chains without both fee forks", () => {
    for (const rules of [
        { gasFee: true, fee: false },
        { gasFee: false, fee: true },
    ]) {
        it(`apply the gas edit as signed, credited to no account (gasFeeSeparation ${rules.gasFee}, feeBinding ${rules.fee})`, async () => {
            forks(rules)
            const before = supply()
            const tx = await web2()

            expect(withDerivedFeeEdits(tx)).toBe(tx)
            const out = await block([tx])

            expect(out.successfulTxs).toEqual([tx.hash])
            expect(balanceOf(SENDER)).toBe(100n * OS - OS)
            expect(balanceOf(BURN) + balanceOf(TREASURY)).toBe(0n)
            expect(supply()).toBe(before - OS)
        })
    }
})

describe("TLSNotary operations under gasFeeSeparation and feeBinding", () => {
    beforeEach(() => {
        forks({ gasFee: true, fee: true })
        getSharedState.forkConfig.nonceEnforcement.activationHeight = 0
    })

    /** A native TLSNotary operation from SENDER on nonce 8, built as the SDK's TLSNotaryService builds it. */
    async function tlsn(nativeOperation: string, args: unknown[], amount: number): Promise<Transaction> {
        demos.getAddressNonce = async () => 7
        const tx = DemosTransactions.empty()
        tx.content.to = SENDER
        tx.content.nonce = 8
        tx.content.amount = amount as never
        tx.content.type = "native"
        tx.content.timestamp = Date.now()
        tx.content.data = ["native", { nativeOperation, args }] as never
        return onTheWire(await demos.sign(tx)) as Transaction
    }
    const request = () => tlsn("tlsn_request", ["https://example.com"], 1)
    // 3000 bytes of proof: 1 DEM plus 1 DEM for each of 3 started KB.
    const store = () => tlsn("tlsn_store", ["token-1", "p".repeat(3000), "onchain"], 4)

    for (const [name, build, burn] of [
        ["request", request, OS],
        ["store", store, 4n * OS],
    ] as const) {
        it(`credits the burn of a ${name} after it and conserves supply`, async () => {
            const tx = await build()
            const applied = withDerivedFeeEdits(tx).content.gcr_edits as any[]
            expect(applied.slice(-4)).toEqual([
                expect.objectContaining({ type: "balance", operation: "remove", account: SENDER, amount: String(burn) }),
                expect.objectContaining({ type: "balance", operation: "add", account: BURN, amount: Number(burn / 2n) }),
                expect.objectContaining({ type: "balance", operation: "add", account: TREASURY, amount: Number(burn / 2n) }),
                expect.objectContaining({ type: "nonce" }),
            ])
            expect(withDerivedFeeEdits(withDerivedFeeEdits(tx)).content.gcr_edits).toEqual(applied)

            const before = supply()
            const out = await block([tx])

            expect(out.failedTxs).toEqual([])
            expect(supply()).toBe(before)
            expect(balanceOf(SENDER)).toBe(100n * OS - burn - FEE)
            // The network fee and the burn split 50/50; the rpc fee folds into treasury.
            expect(balanceOf(BURN)).toBe(OS / 2n + burn / 2n)
            expect(balanceOf(TREASURY)).toBe(OS / 2n + OS + burn / 2n)
        })

        it(`charges a ${name} that fails in the block its fee only, and conserves supply`, async () => {
            caches = freshCaches(FEE + burn - 1n)
            const before = supply()
            const tx = await build()

            const out = await block([tx])

            expect(out.failedTxs).toEqual([tx.hash])
            expect(supply()).toBe(before)
            expect(balanceOf(SENDER)).toBe(burn - 1n)
            expect(nonceOf(SENDER)).toBe(8)
        })
    }

    it("applies a served block the same on a syncing node, and rolls it back", async () => {
        const start = balances()
        const tx = await store()
        await block([tx])
        const producer = balances()

        caches = freshCaches(100n * OS)
        const out = await block([onTheWire(tx)])
        expect(out.failedTxs).toEqual([])
        expect(balances()).toEqual(producer)

        const back = await HandleGCR.applyTransactions([onTheWire(tx)], true)
        expect(back.failedTxs).toEqual([])
        expect(balances()).toEqual(start)
    })

    it("leaves the burn uncredited with feeBinding off, as applied before", async () => {
        forks({ gasFee: true, fee: false })
        const before = supply()
        const tx = await request()

        await block([tx])

        // The gas is charged too on that chain, and neither is credited.
        expect(supply()).toBe(before - 2n * OS)
    })
})
