/**
 * What a block pays out for a native transaction, judged on the signed body:
 *  - `nativeSendBinding`: a send pays the recipient and amount its body names
 *    (`content.to`, `content.amount`), never other ones hidden in its args;
 *  - `canonicalAddresses`: an account is keyed by its lowercase hex, so a
 *    transfer to an upper-case spelling would land in an account no wallet
 *    reads;
 *  - `feeBinding`: the fee a native transaction carries is the one the
 *    network charges, whatever path brought it into the block.
 * Before each fork the block applies what it always did.
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
import { getSharedState } from "@/utilities/sharedState"
import type { GCREntityCaches } from "./handleGCR"
import { OS, PEER, SENDER, VICTIM, demos, onTheWire } from "@/libs/blockchain/validation/editBinding.fixtures"
import Hashing from "@/libs/crypto/hashing"
import { serializeTxContent } from "@/libs/crypto/txContentSerializer"

const { default: HandleGCR } = await import("./handleGCR")

const PEER_UPPER = "0x" + PEER.slice(2).toUpperCase()
const TREASURY = "0x" + "f7".repeat(32)
const BURN = "0x" + "00".repeat(32)

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
}
const savedSdk = {
    params: demos._getNetworkParametersCached,
    applyFee: demos._calculateAndApplyGasFee,
}

function freshCaches(): GCREntityCaches {
    const account = (pubkey: string, balance: bigint) => [pubkey, { pubkey, balance, nonce: 7 } as any] as const
    return {
        // The upper-case spelling of PEER is a row of its own, as
        // prepareEntities would create it for a credit to that key.
        accounts: new Map([
            account(SENDER, 100n * OS),
            account(VICTIM, 5n * OS),
            account(PEER, 0n),
            account(PEER_UPPER, 0n),
            account(TREASURY, 0n),
            account(BURN, 0n),
        ]),
        storagePrograms: new Map(),
        tlsNotaries: new Map(),
        atomicWorks: new Map(),
        resourceSlots: new Map(),
    }
}

type Rules = { send?: boolean; canonical?: boolean; fee?: boolean; gasFee?: boolean }

/** Mainnet-like forks, with the rules under test switched on or left dormant. */
function forks(rules: Rules) {
    const config = cloneDefaultForkConfig() as ForkConfigByName & Record<string, { activationHeight: number | null }>
    config.osDenomination.activationHeight = 0
    config.editBinding.activationHeight = 0
    config.nonceEnforcement.activationHeight = null
    config.gasFeeSeparation.activationHeight = rules.gasFee ? 0 : null
    // Written by name, so the test runs against a build without these forks.
    config.nativeSendBinding = { activationHeight: rules.send ? 0 : null }
    config.canonicalAddresses = { activationHeight: rules.canonical ? 0 : null }
    config.feeBinding = { activationHeight: rules.fee ? 0 : null }
    getSharedState.forkConfig = config
    getSharedState.lastBlockNumber = 100
    tip = 100
}

const balanceOf = (key: string) => (caches.accounts.get(key) as any).balance as bigint
const nonceOf = (key: string) => (caches.accounts.get(key) as any).nonce as number

/**
 * Whether the signed hash still covers `tx` after osDenomination: the
 * serializer hashes a DEM number as the OS string it stands for, so a body
 * rewritten from one shape to the other keeps its signature.
 */
const hashCovers = (tx: Transaction) => Hashing.sha256(serializeTxContent(tx.content, true)) === tx.hash

/** A send signed by the real signer whose body and args can disagree. */
async function send(opts: {
    to: string
    amount: bigint
    argsTo?: string
    argsAmount?: bigint | number
}): Promise<Transaction> {
    const tx = DemosTransactions.empty()
    tx.content.type = "native" as never
    tx.content.to = opts.to
    tx.content.amount = opts.amount as never
    tx.content.nonce = 8
    tx.content.timestamp = Date.now()
    tx.content.data = [
        "native",
        {
            nativeOperation: "send",
            args: [
                opts.argsTo ?? opts.to,
                typeof opts.argsAmount === "number" ? opts.argsAmount : String(opts.argsAmount ?? opts.amount),
            ],
        },
    ] as never
    return onTheWire(await demos.sign(tx))
}

/** A transfer signed with the fee fields a client chose. */
async function payWithFee(fee: Record<string, unknown>): Promise<Transaction> {
    demos._getNetworkParametersCached = async () => {
        throw new Error("offline")
    }
    demos._calculateAndApplyGasFee = (raw: any) => {
        raw.content.transaction_fee = fee
        return raw
    }
    try {
        return onTheWire(await DemosTransactions.pay(PEER, 3n * OS, demos))
    } finally {
        demos._getNetworkParametersCached = savedSdk.params
        demos._calculateAndApplyGasFee = savedSdk.applyFee
    }
}

beforeEach(() => {
    caches = freshCaches()
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
    // The fee the network charges: what the fixture's SDK is told as well.
    getSharedState.networkFee = 1
    getSharedState.rpcFee = 0
    getSharedState.additionalFee = 0
})

afterEach(() => {
    Object.assign(getSharedState, savedState)
    Object.assign(HandleGCR, original)
})

describe("a native send whose args name another payment than its body", () => {
    it("pays the args before nativeSendBinding, whatever the body says", async () => {
        forks({})
        const tx = await send({ to: VICTIM, amount: 3n * OS, argsTo: PEER })

        const out = await HandleGCR.applyTransactions([tx], false)

        expect(out.failedTxs).toEqual([])
        expect(balanceOf(PEER)).toBe(3n * OS)
        expect(balanceOf(VICTIM)).toBe(5n * OS)
    })

    it("is refused behind nativeSendBinding when the recipient differs", async () => {
        forks({ send: true })
        const tx = await send({ to: VICTIM, amount: 3n * OS, argsTo: PEER })

        const out = await HandleGCR.applyTransactions([tx], false)

        expect(out.failedTxs).toEqual([tx.hash])
        expect(balanceOf(PEER)).toBe(0n)
        expect(balanceOf(SENDER)).toBe(100n * OS)
        expect(nonceOf(SENDER)).toBe(7)
    })

    it("is refused behind nativeSendBinding when the amount differs", async () => {
        forks({ send: true })
        const tx = await send({ to: PEER, amount: 1n, argsAmount: 50n * OS })

        const out = await HandleGCR.applyTransactions([tx], false)

        expect(out.failedTxs).toEqual([tx.hash])
        expect(balanceOf(PEER)).toBe(0n)
    })

    it("is refused behind nativeSendBinding when its args pay in OS the DEM number its body names", async () => {
        forks({ send: true })
        // Args of 3 pay 3 OS; a body amount of 3 names 3 DEM to the hash,
        // the receipts and the RPC balance check.
        const tx = await send({ to: PEER, amount: 3n * OS, argsAmount: 3 })
        tx.content.amount = 3 as never
        expect(hashCovers(tx)).toBe(true)

        const out = await HandleGCR.applyTransactions([tx], false)

        expect(out.failedTxs).toEqual([tx.hash])
        expect(balanceOf(PEER)).toBe(0n)
        expect(balanceOf(SENDER)).toBe(100n * OS)
    })

    it("applies a send whose body names in DEM the OS its args pay behind nativeSendBinding", async () => {
        forks({ send: true })
        const tx = await send({ to: PEER, amount: 3n * OS })
        tx.content.amount = 3 as never
        expect(hashCovers(tx)).toBe(true)

        const out = await HandleGCR.applyTransactions([tx], false)

        expect(out.failedTxs).toEqual([])
        expect(balanceOf(PEER)).toBe(3n * OS)
    })

    it("applies a send whose args are its body behind nativeSendBinding", async () => {
        forks({ send: true })
        const tx = onTheWire(await DemosTransactions.pay(PEER, 3n * OS, demos))

        const out = await HandleGCR.applyTransactions([tx], false)

        expect(out.failedTxs).toEqual([])
        expect(balanceOf(PEER)).toBe(3n * OS)
    })
})

describe("a native send to an upper-case spelling of an address", () => {
    it("credits a separate account before canonicalAddresses", async () => {
        forks({})
        const tx = onTheWire(await DemosTransactions.pay(PEER_UPPER, 3n * OS, demos))

        const out = await HandleGCR.applyTransactions([tx], false)

        expect(out.failedTxs).toEqual([])
        expect(balanceOf(PEER_UPPER)).toBe(3n * OS)
        expect(balanceOf(PEER)).toBe(0n)
    })

    it("is refused behind canonicalAddresses, and nothing moves", async () => {
        forks({ canonical: true })
        const tx = onTheWire(await DemosTransactions.pay(PEER_UPPER, 3n * OS, demos))

        const out = await HandleGCR.applyTransactions([tx], false)

        expect(out.failedTxs).toEqual([tx.hash])
        expect(balanceOf(PEER_UPPER)).toBe(0n)
        expect(balanceOf(PEER)).toBe(0n)
        expect(balanceOf(SENDER)).toBe(100n * OS)
        expect(nonceOf(SENDER)).toBe(7)
    })

    it("lets a lowercase transfer through behind canonicalAddresses", async () => {
        forks({ canonical: true })
        const tx = onTheWire(await DemosTransactions.pay(PEER, 3n * OS, demos))

        const out = await HandleGCR.applyTransactions([tx], false)

        expect(out.failedTxs).toEqual([])
        expect(balanceOf(PEER)).toBe(3n * OS)
    })
})

describe("a native transfer that reaches a block with a fee the network does not charge", () => {
    const zero = { network_fee: "0", rpc_fee: "0", additional_fee: "0", rpc_address: null }

    it("pays no fee before feeBinding", async () => {
        forks({ gasFee: true })
        const tx = await payWithFee(zero)

        const out = await HandleGCR.applyTransactions([tx], false)

        expect(out.failedTxs).toEqual([])
        // The amount and the 1 DEM gas edit only.
        expect(balanceOf(SENDER)).toBe(100n * OS - 3n * OS - OS)
        expect(balanceOf(TREASURY)).toBe(0n)
    })

    it("is refused behind feeBinding when it understates the fee", async () => {
        forks({ gasFee: true, fee: true })
        const tx = await payWithFee(zero)

        const out = await HandleGCR.applyTransactions([tx], false)

        expect(out.failedTxs).toEqual([tx.hash])
        expect(balanceOf(SENDER)).toBe(100n * OS)
        expect(balanceOf(PEER)).toBe(0n)
    })

    it("is refused behind feeBinding when it routes the rpc share to an account it chose", async () => {
        getSharedState.rpcFee = 1
        forks({ gasFee: true, fee: true })
        const tx = await payWithFee({ network_fee: "1000000000", rpc_fee: "1000000000", additional_fee: "0", rpc_address: SENDER })

        const out = await HandleGCR.applyTransactions([tx], false)

        expect(out.failedTxs).toEqual([tx.hash])
        expect(balanceOf(SENDER)).toBe(100n * OS)
    })

    /** A transfer charged the network fee, its body then showing that fee as a DEM number. */
    async function demNumberFee(): Promise<Transaction> {
        const tx = await payWithFee({ network_fee: 1, rpc_fee: 0, additional_fee: 0, rpc_address: null })
        expect(tx.content.transaction_fee.network_fee).toBe("1000000000")
        tx.content.transaction_fee = { network_fee: 1, rpc_fee: 0, additional_fee: 0, rpc_address: null } as never
        expect(hashCovers(tx)).toBe(true)
        return tx
    }

    it("pays one OS for a network fee of one DEM shipped as a number before feeBinding", async () => {
        forks({ gasFee: true })
        const tx = await demNumberFee()

        const out = await HandleGCR.applyTransactions([tx], false)

        expect(out.failedTxs).toEqual([])
        expect(balanceOf(SENDER)).toBe(100n * OS - 3n * OS - OS - 1n)
    })

    it("is refused behind feeBinding when it ships the network fee as a DEM number", async () => {
        forks({ gasFee: true, fee: true })
        const tx = await demNumberFee()

        const out = await HandleGCR.applyTransactions([tx], false)

        expect(out.failedTxs).toEqual([tx.hash])
        expect(balanceOf(SENDER)).toBe(100n * OS)
        expect(balanceOf(PEER)).toBe(0n)
    })

    it("charges the fee of an honest transfer behind feeBinding", async () => {
        forks({ gasFee: true, fee: true })
        const tx = onTheWire(await DemosTransactions.pay(PEER, 3n * OS, demos))

        const out = await HandleGCR.applyTransactions([tx], false)

        expect(out.failedTxs).toEqual([])
        expect(balanceOf(PEER)).toBe(3n * OS)
        // The fee edits replace the SDK gas edit: the network fee once, split
        // between burn and treasury, and nothing else.
        expect(balanceOf(SENDER)).toBe(100n * OS - 3n * OS - OS)
        expect(balanceOf(TREASURY)).toBe(OS / 2n)
        expect(balanceOf(BURN)).toBe(OS / 2n)
    })

    it("leaves a non-native transaction to the rules it had", async () => {
        forks({ gasFee: true, fee: true })
        const tx = onTheWire(
            await (async () => {
                const t = DemosTransactions.empty()
                t.content.type = "contractCall" as never
                t.content.to = SENDER
                t.content.nonce = 8
                t.content.timestamp = Date.now()
                t.content.data = ["contractCall", { contractAddress: PEER, method: "get", args: [] }] as never
                return await demos.sign(t)
            })(),
        )
        tx.content.transaction_fee = zero as never

        const out = await HandleGCR.applyTransactions([tx], false)

        expect(out.failedTxs).toEqual([])
    })
})
