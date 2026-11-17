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
        getAccountBalance: async (address: string) => {
            balanceReads.push(address)
            onBalanceRead?.()
            return balance(address)
        },
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

import { DemosTransactions, GCRGeneration } from "@kynesyslabs/demosdk/websdk"
import { Identities } from "@kynesyslabs/demosdk/abstraction"
import { D402Client } from "@kynesyslabs/demosdk/d402/client"
import { getSharedState } from "@/utilities/sharedState"
import { OS, PEER, SENDER, chainIs, demos, onTheWire, viaConfirm } from "../validation/editBinding.fixtures"
import type { Transaction } from "@kynesyslabs/demosdk/types"
import type { GCREntityCaches } from "../gcr/handleGCR"

const { confirmTransaction } = await import("./validateTransaction")
const { handleValidateTransaction } = await import("../../network/endpointValidation")
const { default: HandleGCR, withDerivedFeeEdits } = await import("../gcr/handleGCR")
const BURN = "0x" + "00".repeat(32)
const TREASURY = "0x" + "f7".repeat(32)
const PQC = "0x" + "ab".repeat(32)
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
const sdkGasEdit = GCRGeneration.createGasEdit
let caches: GCREntityCaches
const balanceReads: string[] = []
let onBalanceRead: (() => void) | null = null
const balance = (key: string): bigint => caches.accounts.get(key)?.balance ?? 0n
const quote = (tx: Transaction): bigint => BigInt((tx.attrs as typeof tx.attrs & { total_fee: string }).total_fee)
const pay = async (amount: bigint) => onTheWire(await DemosTransactions.pay(PEER, amount, demos))
const confirm = async (tx: Transaction) => (await confirmTransaction(tx as never, SENDER)).data

beforeEach(() => {
    balanceReads.length = 0
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
        accounts: new Map([SENDER, PEER, BURN, TREASURY, PQC].map(pubkey => [
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
    GCRGeneration.createGasEdit = sdkGasEdit
    onBalanceRead = null
})

afterAll(() => mock.restore())

describe("native send confirmation fee quote", () => {
    it("accepts a linked signer when each account covers its own debits", async () => {
        chainIs(true, null)
        getSharedState.forkConfig.gasFeeSeparation.activationHeight = 0
        caches.accounts.get(SENDER)!.balance = 100n * OS
        caches.accounts.get(PQC)!.balance = 2n * OS
        const tx = await pay(98n * OS)
        tx.content.from = PQC
        tx.content.from_ed25519_address = SENDER

        const removes = tx.content.gcr_edits.filter(edit =>
            edit.type === "balance" && edit.operation === "remove")
        expect(removes.map(edit => edit.account)).toEqual([SENDER, SENDER])
        expect(BigInt(removes[0].amount)).toBe(98n * OS)
        expect(removes.reduce((sum, edit) => sum + BigInt(edit.amount), 0n)).toBe(99n * OS)
        const appliedRemoves = withDerivedFeeEdits(tx).content.gcr_edits.filter(edit =>
            edit.type === "balance" && edit.operation === "remove")
        expect(appliedRemoves.map(edit => edit.account)).toEqual([PQC, PQC, SENDER, SENDER])
        expect(appliedRemoves.slice(0, 2).reduce((sum, edit) =>
            sum + BigInt(edit.amount), 0n)).toBe(2n * OS)
        expect((await confirm(tx)).valid).toBe(true)
        expect(quote(tx)).toBe(3n * OS)
        expect(balanceReads.slice(1)).toEqual([PQC, SENDER])
    })

    it("refuses a linked signer when the send and gas account falls short", async () => {
        chainIs(true, null)
        getSharedState.forkConfig.gasFeeSeparation.activationHeight = 0
        caches.accounts.get(SENDER)!.balance = 98n * OS
        caches.accounts.get(PQC)!.balance = 101n * OS
        const tx = await pay(98n * OS)
        tx.content.from = PQC
        tx.content.from_ed25519_address = SENDER

        const verdict = await confirm(tx)
        expect(verdict.valid).toBe(false)
        expect(verdict.message).toContain(SENDER)
        expect(verdict.message).toContain(`required ${99n * OS}`)
        expect(verdict.message).toContain(`balance ${98n * OS}`)
        expect(quote(tx)).toBe(3n * OS)
        expect(balanceReads.slice(1)).toEqual([PQC, SENDER])
    })

    it("reads only the signing accounts' balances for native sends", async () => {
        chainIs(true, null)
        getSharedState.forkConfig.gasFeeSeparation.activationHeight = null
        caches.accounts.get(SENDER)!.balance = 100n * OS
        const tx = await pay(1n * OS)

        expect((await confirm(tx)).valid).toBe(true)
        expect(balanceReads).toEqual([SENDER])
    })

    it("reads only the signing accounts' balances for submitted edits", async () => {
        chainIs(true, null)
        getSharedState.forkConfig.gasFeeSeparation.activationHeight = null
        caches.accounts.get(SENDER)!.balance = 100n * OS
        const tx = await pay(1n * OS)
        const balanceEdit = tx.content.gcr_edits.find(edit => edit.type === "balance")!
        for (let i = 0; i < 1000; i++) {
            tx.content.gcr_edits.push({
                ...balanceEdit,
                operation: "remove",
                account: "0x" + (i + 1).toString(16).padStart(64, "0"),
                amount: "0",
            } as typeof balanceEdit)
        }

        const verdict = await confirm(tx)
        expect(verdict.valid).toBe(false)
        expect(verdict.message).toContain("debit from an account that does not sign this transaction")
        expect(balanceReads).toEqual([])

        const rpc = await handleValidateTransaction(tx, SENDER)
        expect(rpc.data.valid).toBe(false)
        expect(rpc.data.message).toContain("debit from an account that does not sign this transaction")
        expect(balanceReads).toEqual([])
    })

    it("refuses a native send when its amount payer cannot cover the amount", async () => {
        chainIs(true, null)
        getSharedState.forkConfig.gasFeeSeparation.activationHeight = 0
        caches.accounts.get(SENDER)!.balance = 97n * OS
        caches.accounts.get(PQC)!.balance = 2n * OS
        const tx = await pay(98n * OS)
        tx.content.from = PQC
        tx.content.from_ed25519_address = SENDER

        const verdict = await confirm(tx)
        expect(verdict.valid).toBe(false)
        expect(verdict.message).toContain(SENDER)
        expect(verdict.message).toContain(`required ${99n * OS}`)
        expect(verdict.message).toContain(`balance ${97n * OS}`)
        expect(quote(tx)).toBe(3n * OS)
    })

    it("retains the amount-only balance refusal for non-native transactions", async () => {
        chainIs(true, null)
        caches.accounts.get(SENDER)!.balance = 1n * OS
        const payment = onTheWire(await demos.sign(await new D402Client(demos).createPayment({
            recipient: PEER, amount: "100000000", resourceId: "res-1", description: "d",
        } as never))) as Transaction
        payment.content.amount = (2n * OS).toString()

        const verdict = await confirm(payment)
        expect(verdict.valid).toBe(false)
        expect(verdict.message).toBe(
            `[Tx Validation] [BALANCE ERROR] Insufficient balance: need ${2n * OS} but have ${1n * OS}\n`,
        )
    })

    it("documents the shipped SDK fee report and cap gap", async () => {
        const doc = await Bun.file("docs/native-send-fee-quote.md").text()
        expect(doc).toContain("gross fee (excluding the amount)")
        expect(doc).toMatch(/SDK up to and including 4\.0\.21/)
        expect(doc).toContain("With `gasFeeSeparation` active and `feeBinding` dormant, the SDK undercounts")
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
        it(`returns a nonce refusal without a client fee quote (editBinding=${binding})`, async () => {
            chainIs(true, binding)
            getSharedState.forkConfig.gasFeeSeparation.activationHeight = 0
            caches.accounts.get(SENDER)!.balance = 100n * OS
            const tx = await pay(1n * OS)
            tx.content.nonce = 7
            tx.attrs = { reference_block: 0, total_fee: "0" } as never
            const balanceEdit = tx.content.gcr_edits.find(edit => edit.type === "balance")!
            tx.content.gcr_edits.push({
                ...balanceEdit,
                operation: "add",
                account: SENDER,
                amount: (1000n * OS).toString(),
            } as typeof balanceEdit)

            const response = await handleValidateTransaction(tx, SENDER)

            // Stabilisation returns a confirm refusal before the edits are
            // compared, so the refused transaction is echoed back.
            expect(response.data.valid).toBe(false)
            expect(response.data.message).toContain("[NONCE ERROR]")
            expect(response.data.transaction).toBe(tx)
            expect((tx.attrs as { total_fee?: string }).total_fee).toBeUndefined()
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
        for (const [separated, bound] of [[false, false], [true, false], [true, true]]) {
            it(`sends balance minus shown fee to zero (${postFork ? "OS" : "DEM"}, separation=${separated}, feeBinding=${bound})`, async () => {
                chainIs(postFork, null)
                getSharedState.forkConfig.gasFeeSeparation.activationHeight = separated ? 0 : null
                getSharedState.forkConfig.feeBinding.activationHeight = bound ? 0 : null
                const unit = postFork ? OS : 1n
                caches.accounts.get(SENDER)!.balance = 100n * unit
                const probe = await pay(3n * OS)
                const signed = JSON.stringify([probe.content, probe.hash, probe.signature, probe.ed25519_signature])
                probe.attrs = { reference_block: 0, total_fee: "0" } as never
                const confirmed = await confirm(probe)
                expect(confirmed.valid).toBe(true)
                expect(quote(confirmed.transaction)).toBe((separated ? (bound ? 2n : 3n) : 1n) * unit)
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

    // Confirmation references block 100. A block can commit while it runs
    // (lastBlockNumber 101), and the chain tip is written before
    // lastBlockNumber follows it (lastBlockNumber 99), so the fee forks can be
    // active at one height and not the other.
    const forkHeights: Array<[number, number, bigint]> = [[101, 101, 2n], [99, 100, 1n]]
    for (const [lastBlockNumber, activation, fee] of forkHeights) {
        it(`quotes the debits the balance check reads (reference 100, last block ${lastBlockNumber}, fee forks at ${activation})`, async () => {
            chainIs(true, null)
            getSharedState.lastBlockNumber = lastBlockNumber
            getSharedState.forkConfig.gasFeeSeparation.activationHeight = activation
            getSharedState.forkConfig.feeBinding.activationHeight = activation
            caches.accounts.get(SENDER)!.balance = 100n * OS
            const amount = 90n * OS
            const tx = await pay(amount)

            const confirmed = await confirm(tx)
            expect(confirmed.valid).toBe(true)
            expect(confirmed.reference_block).toBe(100)
            expect((tx.attrs as { reference_block: number }).reference_block).toBe(100)
            const debits = withDerivedFeeEdits(tx).content.gcr_edits
                .filter(edit => edit.type === "balance" && edit.operation === "remove")
                .reduce((sum, edit) => sum + BigInt(edit.amount), 0n)
            expect(quote(tx)).toBe(debits - amount)
            expect(quote(tx)).toBe(fee * OS)
        })
    }

    // A block commits while confirmation awaits the SDK gas edit the quote
    // reads, or a balance read: each commit advances lastBlockNumber by one
    // from 100. Fee forks at 101 are crossed by the first commit; at 0 or
    // null no commit crosses them, and the change of height alone refuses.
    // The 100 DEM send would otherwise be refused by the quote's balance
    // check with this node's quote attached; with both fee forks active the
    // ingress fee check refuses it before the quote, so only 1 DEM is sent.
    const advancedRefusal =
        "[Tx Validation] [FEE ERROR] the chain advanced while the fee was being quoted; confirm again\n"
    const commit = (): void => {
        getSharedState.lastBlockNumber = (getSharedState.lastBlockNumber ?? 0) + 1
    }
    const commitDuring = {
        "the gas edit": () => {
            GCRGeneration.createGasEdit = async (...args: Parameters<typeof sdkGasEdit>) => {
                const edit = await sdkGasEdit(...args)
                commit()
                return edit
            }
        },
        "a balance read": () => { onBalanceRead = commit },
    }
    const midQuoteCommits: Array<[string, number | null, number | null, keyof typeof commitDuring, bigint[]]> = [
        ["crossing the fee forks", 101, 101, "the gas edit", [1n, 100n]],
        ["crossing the fee forks", 101, 101, "a balance read", [1n, 100n]],
        ["crossing no fork, both fee forks active", 0, 0, "a balance read", [1n]],
        ["crossing no fork, gasFeeSeparation active", 0, null, "the gas edit", [1n, 100n]],
        ["crossing no fork, gasFeeSeparation active", 0, null, "a balance read", [1n, 100n]],
        ["crossing no fork, fee forks dormant", null, null, "the gas edit", [1n, 100n]],
        ["crossing no fork, fee forks dormant", null, null, "a balance read", [1n, 100n]],
    ]
    for (const [label, separation, binding, during, amounts] of midQuoteCommits) {
        for (const amount of amounts) {
            it(`refuses without a quote when a block commits during ${during} (${label}, send ${amount} DEM)`, async () => {
                chainIs(true, null)
                getSharedState.forkConfig.gasFeeSeparation.activationHeight = separation
                getSharedState.forkConfig.feeBinding.activationHeight = binding
                caches.accounts.get(SENDER)!.balance = 100n * OS
                const tx = await pay(amount * OS)
                commitDuring[during]()

                const response = await handleValidateTransaction(tx, SENDER)

                expect(getSharedState.lastBlockNumber).toBeGreaterThan(100)
                expect(response.data.valid).toBe(false)
                expect(response.data.message).toBe(advancedRefusal)
                expect(response.data.reference_block).toBe(100)
                expect(response.data.transaction).toBe(tx)
                expect(tx.attrs as unknown).toEqual({ reference_block: 100 })
            })
        }
    }

    // The fee forks are active at lastBlockNumber 101 but not at reference
    // block 100, so the ingress fee check has not read transaction_fee.
    const forksAfterReference = (): void => {
        chainIs(true, null)
        getSharedState.lastBlockNumber = 101
        getSharedState.forkConfig.gasFeeSeparation.activationHeight = 101
        getSharedState.forkConfig.feeBinding.activationHeight = 101
        caches.accounts.get(SENDER)!.balance = 100n * OS
    }
    const unreadableFees: Array<[string, (content: any) => void, string]> = [
        ["no transaction_fee", content => { delete content.transaction_fee }, "transaction_fee is missing or not an object"],
        ["rpc_fee 1.5", content => { content.transaction_fee.rpc_fee = "1.5" }, "transaction_fee.rpc_fee is not a non-negative integer"],
        ["network_fee -1", content => { content.transaction_fee.network_fee = -1 }, "transaction_fee.network_fee is not a non-negative integer"],
        // Pin the inputs the component check refuses: past the safe integer
        // range, a non-numeric type, and digits outside 0-9.
        ["network_fee 2^53", content => { content.transaction_fee.network_fee = 2 ** 53 }, "transaction_fee.network_fee is not a non-negative integer"],
        ["additional_fee true", content => { content.transaction_fee.additional_fee = true }, "transaction_fee.additional_fee is not a non-negative integer"],
        ["rpc_fee in Arabic-Indic digits", content => { content.transaction_fee.rpc_fee = "١" }, "transaction_fee.rpc_fee is not a non-negative integer"],
    ]
    for (const [label, change, reason] of unreadableFees) {
        it(`refuses a fee it cannot read when the fee forks follow the reference block (${label})`, async () => {
            forksAfterReference()
            const tx = await pay(1n * OS)
            change(tx.content)

            const refusal = await confirm(tx)
            expect(refusal.valid).toBe(false)
            expect(refusal.message).toBe(`[Tx Validation] [FEE ERROR] ${reason}\n`)
            expect((tx.attrs as { total_fee?: string } | undefined)?.total_fee).toBeUndefined()
        })
    }

    it("quotes digit-string fee components at the shipped total when the fee forks follow the reference block", async () => {
        forksAfterReference()
        const amount = 90n * OS
        const shipped = await pay(amount)
        const digits = onTheWire(shipped)
        const fee = digits.content.transaction_fee as unknown as Record<string, unknown>
        for (const key of ["network_fee", "rpc_fee", "additional_fee"]) {
            fee[key] = String(BigInt((fee[key] ?? 0) as number | string))
            expect(fee[key]).toMatch(/^[0-9]+$/)
        }
        const signedSum = ["network_fee", "rpc_fee", "additional_fee"]
            .reduce((sum, key) => sum + BigInt(fee[key] as string), 0n)

        expect((await confirm(shipped)).valid).toBe(true)
        expect((await confirm(digits)).valid).toBe(true)
        expect(quote(digits)).toBe(quote(shipped))
        expect(quote(digits)).toBe(signedSum)
        expect(quote(digits)).toBe(2n * OS)
        const debits = withDerivedFeeEdits(digits).content.gcr_edits
            .filter(edit => edit.type === "balance" && edit.operation === "remove")
            .reduce((sum, edit) => sum + BigInt(edit.amount), 0n)
        expect(quote(digits)).toBe(debits - amount)
    })

    it("sends balance minus the quote when a block activating the fee forks commits during confirmation", async () => {
        chainIs(true, null)
        getSharedState.lastBlockNumber = 101
        getSharedState.forkConfig.gasFeeSeparation.activationHeight = 101
        getSharedState.forkConfig.feeBinding.activationHeight = 101
        caches.accounts.get(SENDER)!.balance = 100n * OS

        const max = await pay(98n * OS)
        expect((await confirm(max)).valid).toBe(true)
        expect(quote(max)).toBe(2n * OS)
        const over = await pay(98n * OS + 1n)
        const refusal = await confirm(over)
        expect(refusal.valid).toBe(false)
        expect(refusal.message).toContain(`quoted total fee ${2n * OS}`)

        const applied = await HandleGCR.applyTransactions([max], false)
        expect(applied.successfulTxs).toEqual([max.hash])
        expect(balance(SENDER)).toBe(0n)
    })

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
