import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test"

mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug() {}, info() {}, warning() {}, error() {}, only() {}, custom() {} },
}))
mock.module("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: {
        getLastBlockNumber: async () => 100,
        getExistingTransactionHashes: async () => new Set<string>(),
    },
}))
mock.module("src/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: {
        getAccountNonce: async () => 7,
        getAccountBalance: async (address: string) => balance(address),
    },
}))
mock.module("src/libs/blockchain/validation/txAdmission", () => ({
    checkTxAdmissible: async () => ({ ok: true }),
}))
mock.module("src/libs/blockchain/validation/validityData", () => ({
    signValidityData: async (data: unknown) => data,
}))
mock.module("src/libs/blockchain/validation/txValidatorPool", () => ({
    __esModule: true,
    default: { getInstance: () => ({ sign: async () => ({ signature: new Uint8Array(1) }) }) },
}))

import { DemosTransactions } from "@kynesyslabs/demosdk/websdk"
import { Identities } from "@kynesyslabs/demosdk/abstraction"
import { D402Client } from "@kynesyslabs/demosdk/d402/client"
import { getSharedState } from "@/utilities/sharedState"
import { OS, PEER, SENDER, chainIs, demos, onTheWire, viaConfirm } from "../validation/editBinding.fixtures"
import type { Transaction } from "@kynesyslabs/demosdk/types"
import type { GCREntityCaches } from "../gcr/handleGCR"

const { confirmTransaction } = await import("./validateTransaction")
const { handleValidateTransaction } = await import("../../network/endpointValidation")
const { default: HandleGCR } = await import("../gcr/handleGCR")
const BURN = "0x" + "00".repeat(32)
const TREASURY = "0x" + "f7".repeat(32)
const saved = {
    forkConfig: getSharedState.forkConfig,
    lastBlockNumber: getSharedState.lastBlockNumber,
    PROD: getSharedState.PROD,
    networkFee: getSharedState.networkFee,
    rpcFee: getSharedState.rpcFee,
    burnFee: getSharedState.burnFee,
    additionalFee: getSharedState.additionalFee,
    feeDistribution: getSharedState.feeDistribution,
}
const original = {
    prepareEntities: HandleGCR.prepareEntities,
    saveGCREditChanges: HandleGCR.saveGCREditChanges,
    bulkUpdateAssignedTxs: HandleGCR.bulkUpdateAssignedTxs,
}
const sdkParameters = demos._getNetworkParametersCached
let caches: GCREntityCaches
const balance = (key: string): bigint => caches.accounts.get(key)!.balance
const quote = (tx: Transaction): bigint => BigInt((tx.attrs as typeof tx.attrs & { total_fee: string }).total_fee)
const pay = async (amount: bigint) => onTheWire(await DemosTransactions.pay(PEER, amount, demos))
const confirm = async (tx: Transaction) => (await confirmTransaction(tx as never, SENDER)).data

beforeEach(() => {
    getSharedState.PROD = true
    getSharedState.networkFee = 1
    getSharedState.rpcFee = 1
    getSharedState.burnFee = 999 // The live SDK gas edit does not read this legacy scalar.
    getSharedState.additionalFee = 0
    demos._getNetworkParametersCached = async () => ({
        networkFee: getSharedState.networkFee,
        rpcFee: getSharedState.rpcFee,
        additionalFee: getSharedState.additionalFee,
    })
    getSharedState.feeDistribution = {
        burnAddress: BURN,
        treasuryAddress: TREASURY,
        networkFee: { burnPct: 50, treasuryPct: 50 },
        additionalFee: { burnPct: 25, treasuryPct: 75 },
        specialOps: { burnPct: 25, rpcPct: 50, treasuryPct: 25 },
    }
    caches = {
        accounts: new Map([SENDER, PEER, BURN, TREASURY].map(pubkey => [
            pubkey, { pubkey, balance: 0n, nonce: 7 } as any,
        ])),
        storagePrograms: new Map(), tlsNotaries: new Map(),
        atomicWorks: new Map(), resourceSlots: new Map(),
    }
    ;(HandleGCR as any).prepareEntities = async () => caches
    ;(HandleGCR as any).saveGCREditChanges = async () => {}
    ;(HandleGCR as any).bulkUpdateAssignedTxs = async () => {}
})

afterEach(() => {
    Object.assign(getSharedState, saved)
    Object.assign(HandleGCR, original)
    demos._getNetworkParametersCached = sdkParameters
})

afterAll(() => mock.restore())

describe("native send confirmation fee quote", () => {
    it("documents the shipped SDK fee report and cap gap", async () => {
        const doc = await Bun.file("docs/native-send-fee-quote.md").text()
        expect(doc).toContain("gross fee (excluding the amount)")
        expect(doc).toMatch(/SDK (?:up to|through|≤) 4\.0\.19/)
        expect(doc).toContain("With `gasFeeSeparation` active, the SDK undercounts")
        expect(doc).toContain("With it dormant, the SDK overcounts")
        expect(doc).toContain("with `gasFeeSeparation` active")
        expect(doc).toContain("node half of #1165")
        expect(doc).toContain("Non-native transactions pay the SDK gas edit plus any debit their own type ships (for example the storage burn); `d402_payment` and `identity` pay no gas.")
        expect(await Bun.file("docs/mainnet/parameters.md").text()).toContain("dormant `calculateCurrentGas`")
    })

    it("returns only node-generated attrs for a native send", async () => {
        chainIs(true, null)
        getSharedState.forkConfig.gasFeeSeparation.activationHeight = 0
        caches.accounts.get(SENDER)!.balance = 100n * OS
        for (const callerAttrs of [{ caller: "value", total_fee: "0" }, "x", ["value"], null]) {
            const tx = await pay(1n * OS)
            tx.attrs = callerAttrs as never

            const response = await handleValidateTransaction(tx, SENDER)
            expect(response.data.valid).toBe(true)
            expect(response.data.transaction.attrs as unknown).toEqual({
                reference_block: 100,
                total_fee: (3n * OS).toString(),
            })
        }
    })

    it("returns the quoted transaction in an RPC full-balance refusal", async () => {
        chainIs(true, null)
        getSharedState.forkConfig.gasFeeSeparation.activationHeight = 0
        caches.accounts.get(SENDER)!.balance = 100n * OS

        const tx = await pay(100n * OS)
        const response = await handleValidateTransaction(tx, SENDER)

        expect(response.data.valid).toBe(false)
        expect(response.data.message).toContain("quoted total fee")
        expect(response.data.transaction).toBe(tx)
        expect(quote(response.data.transaction)).toBe(3n * OS)
    })

    for (const binding of [null, 0]) {
        it(`checks edits before returning a nonce refusal (editBinding=${binding})`, async () => {
            chainIs(true, binding)
            getSharedState.forkConfig.gasFeeSeparation.activationHeight = 0
            caches.accounts.get(SENDER)!.balance = 100n * OS
            const tx = await pay(1n * OS)
            tx.content.nonce = 7
            const balanceEdit = tx.content.gcr_edits.find(edit => edit.type === "balance")!
            tx.content.gcr_edits.push({
                ...balanceEdit,
                operation: "add",
                account: SENDER,
                amount: (1000n * OS).toString(),
            } as typeof balanceEdit)

            const response = await handleValidateTransaction(tx, SENDER)

            expect(response.data.valid).toBe(false)
            expect(response.data.message).toBe("GCREdit mismatch")
            expect(response.data.transaction).toBeNull()
        })
    }

    it("does not throw while checking a native transaction with no send payload", async () => {
        chainIs(true, null)
        getSharedState.forkConfig.gasFeeSeparation.activationHeight = null
        caches.accounts.get(SENDER)!.balance = 100n * OS

        for (const data of [undefined, []]) {
            const tx = await pay(1n * OS)
            tx.content.data = data as never
            const response = await confirm(tx)
            expect(response.valid).toBe(true)
            expect((response.transaction.attrs as { total_fee?: string } | undefined)?.total_fee).toBeUndefined()
        }
    })

    for (const postFork of [false, true]) {
        for (const separated of [false, true]) {
            it(`sends balance minus shown fee to zero (${postFork ? "OS" : "DEM"}, separation=${separated})`, async () => {
                chainIs(postFork, null)
                getSharedState.forkConfig.gasFeeSeparation.activationHeight = separated ? 0 : null
                const unit = postFork ? OS : 1n
                caches.accounts.get(SENDER)!.balance = 100n * unit
                const probe = await pay(3n * OS)
                const signed = JSON.stringify([probe.content, probe.hash, probe.signature, probe.ed25519_signature])
                probe.attrs = { reference_block: 0, total_fee: "0" } as never
                const confirmed = await confirm(probe)
                expect(confirmed.valid).toBe(true)
                expect(quote(confirmed.transaction)).toBe((separated ? 3n : 1n) * unit)
                expect(JSON.stringify([probe.content, probe.hash, probe.signature, probe.ed25519_signature])).toBe(signed)

                const shownFee = quote(confirmed.transaction)
                const amount = 100n * unit - shownFee
                const tx = await pay(postFork ? amount : amount * OS)
                expect((await confirm(tx)).valid).toBe(true)
                expect(quote(tx)).toBe(shownFee)
                const result = await HandleGCR.applyTransactions([tx], false)
                expect(result.successfulTxs).toEqual([tx.hash])
                expect(result.failedTxs).toEqual([])
                expect(balance(SENDER)).toBe(0n)
                expect(balance(PEER)).toBe(amount)
                expect(100n * unit - balance(SENDER) - balance(PEER)).toBe(shownFee)
            })
        }
    }

    it("refuses legacy signed-fee send max before it can charge the sender", async () => {
        chainIs(true, null)
        getSharedState.forkConfig.gasFeeSeparation.activationHeight = 0
        getSharedState.forkConfig.nonceIntegrity.activationHeight = 0
        caches.accounts.get(SENDER)!.balance = 100n * OS

        const probe = await pay(1n * OS)
        const fees = probe.content.transaction_fee
        const signedFee = BigInt(fees.network_fee ?? 0) +
            BigInt(fees.rpc_fee ?? 0) + BigInt(fees.additional_fee ?? 0)
        expect(signedFee).toBe(2n * OS)
        const legacyMax = await pay(100n * OS - signedFee)
        const refusal = await confirm(legacyMax)
        expect(refusal.valid).toBe(false)
        expect(quote(legacyMax)).toBe(3n * OS)
        expect(refusal.message).toContain(`quoted total fee ${3n * OS}`)
        expect(balance(SENDER)).toBe(100n * OS)
        expect(caches.accounts.get(SENDER)!.nonce).toBe(7)

        const quotedMax = await pay(100n * OS - quote(legacyMax))
        expect((await confirm(quotedMax)).valid).toBe(true)
        const applied = await HandleGCR.applyTransactions([quotedMax], false)
        expect(applied.successfulTxs).toEqual([quotedMax.hash])
        expect(balance(SENDER)).toBe(0n)
    })

    it("confirms SDK non-native transactions below the uncharged distribution fee", async () => {
        chainIs(true, null)
        getSharedState.forkConfig.gasFeeSeparation.activationHeight = 0
        caches.accounts.get(SENDER)!.balance = 1_500_000_000n
        const payment = onTheWire(await demos.sign(await new D402Client(demos).createPayment({
            recipient: PEER, amount: "100000000", resourceId: "res-1", description: "d",
        } as never))) as Transaction
        const identity = onTheWire(await viaConfirm(() => new Identities().removeWeb2Identity(
            demos, { context: "github", username: "someone" } as never,
        ))) as Transaction
        const verdicts = await Promise.all([payment, identity].map(async tx =>
            [tx.content.type, (await confirm(tx)).valid]))
        expect(verdicts).toEqual([["d402_payment", true], ["identity", true]])
    })

    it("quotes the gross fee and credits the treasury sender's share", async () => {
        chainIs(true, null)
        getSharedState.forkConfig.gasFeeSeparation.activationHeight = 0
        getSharedState.feeDistribution.treasuryAddress = SENDER
        caches.accounts.get(SENDER)!.balance = 100n * OS
        const tx = await pay(97n * OS)

        expect((await confirm(tx)).valid).toBe(true)
        expect(quote(tx)).toBe(3n * OS)
        const result = await HandleGCR.applyTransactions([tx], false)
        expect(result.successfulTxs).toEqual([tx.hash])
        expect(balance(SENDER)).toBe(3n * OS / 2n)
    })

    it("quotes governed distribution fees plus SDK gas, without changing signed fees", async () => {
        chainIs(true, null)
        getSharedState.forkConfig.gasFeeSeparation.activationHeight = 0
        caches.accounts.get(SENDER)!.balance = 100n * OS
        getSharedState.networkFee = 5
        getSharedState.rpcFee = 7
        getSharedState.additionalFee = 11
        // SDK 4.0.19's parameter path pins additional_fee to zero. Supply
        // the governed split before its real signer serializes and signs it.
        demos._getNetworkParametersCached = async () => { throw new Error("offline") }
        const applyFees = demos._calculateAndApplyGasFee
        demos._calculateAndApplyGasFee = (raw: Transaction) => {
            raw.content.transaction_fee = {
                network_fee: 5, rpc_fee: 7, additional_fee: 11, rpc_address: null,
            }
            return raw
        }
        let tx: Transaction
        try {
            tx = await pay(3n * OS)
        } finally {
            demos._calculateAndApplyGasFee = applyFees
        }
        const signedFee = JSON.stringify(tx.content.transaction_fee)
        expect((await confirm(tx)).valid).toBe(true)
        expect(quote(tx)).toBe(24n * OS)
        expect(JSON.stringify(tx.content.transaction_fee)).toBe(signedFee)
        const result = await HandleGCR.applyTransactions([tx], false)
        expect(result.successfulTxs).toEqual([tx.hash])
        expect(100n * OS - balance(SENDER) - balance(PEER)).toBe(quote(tx))
    })

    for (const chargeFailure of [false, true]) {
        it(`preserves apply failure charging (nonceIntegrity=${chargeFailure})`, async () => {
            chainIs(true, null)
            getSharedState.forkConfig.gasFeeSeparation.activationHeight = 0
            getSharedState.forkConfig.nonceIntegrity.activationHeight = chargeFailure ? 0 : null
            caches.accounts.get(SENDER)!.balance = 101n * OS
            const tx = await pay(98n * OS)
            expect((await confirm(tx)).valid).toBe(true)
            expect(quote(tx)).toBe(3n * OS)
            caches.accounts.get(SENDER)!.balance = 100n * OS
            const result = await HandleGCR.applyTransactions([tx], false)
            expect(result.failedTxs).toEqual([tx.hash])
            expect(balance(PEER)).toBe(0n)
            expect(balance(SENDER)).toBe(100n * OS - (chargeFailure ? quote(tx) : 0n))
            expect(caches.accounts.get(SENDER)!.nonce).toBe(chargeFailure ? 8 : 7)
        })
    }
})
