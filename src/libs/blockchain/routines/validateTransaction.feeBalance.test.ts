/**
 * RPC confirm of a native transfer built and signed by the SDK, under
 * gasFeeSeparation and feeBinding: the block debits the amount and the fee
 * the transaction names, nothing else, so confirm requires the sender to hold
 * exactly that sum. The chain, the GCR reads, admission and the validity
 * signature are replaced.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"

let balance = 0n
mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug: () => {}, info: () => {}, warning: () => {}, warn: () => {}, error: () => {}, only: () => {}, custom: () => {} },
}))
mock.module("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getLastBlockNumber: async () => 100 },
}))
mock.module("src/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: {
        getAccountNonce: async () => 7,
        getAccountBalance: async () => balance,
    },
}))
mock.module("src/libs/blockchain/validation/txAdmission", () => ({
    checkTxAdmissible: async () => ({ ok: true }),
}))
mock.module("src/libs/blockchain/validation/validityData", () => ({
    signValidityData: async (v: unknown) => v,
}))

import { DemosTransactions } from "@kynesyslabs/demosdk/websdk"
import type { Transaction } from "@kynesyslabs/demosdk/types"
import { getSharedState } from "@/utilities/sharedState"
import { OS, PEER, SENDER, chainIs, demos, onTheWire } from "src/libs/blockchain/validation/editBinding.fixtures"

const { confirmTransaction } = await import("./validateTransaction")

const AMOUNT = 3n * OS
const FEE = 2n * OS // network_fee 1 DEM + rpc_fee 1 DEM
const saved = {
    forkConfig: getSharedState.forkConfig,
    feeDistribution: getSharedState.feeDistribution,
    networkFee: getSharedState.networkFee,
    rpcFee: getSharedState.rpcFee,
    additionalFee: getSharedState.additionalFee,
    lastBlockNumber: getSharedState.lastBlockNumber,
}
const savedParams = demos._getNetworkParametersCached

const confirm = async (tx: Transaction) => (await confirmTransaction(tx as never, SENDER)).data
const transfer = async () => onTheWire(await DemosTransactions.pay(PEER, AMOUNT, demos))

function forks(feeBinding: boolean) {
    chainIs(true, 0)
    getSharedState.forkConfig.gasFeeSeparation.activationHeight = 0
    ;(getSharedState.forkConfig as any).feeBinding = { activationHeight: feeBinding ? 0 : null }
}

beforeEach(() => {
    getSharedState.networkFee = 1
    getSharedState.rpcFee = 1
    getSharedState.additionalFee = 0
    getSharedState.feeDistribution = {
        burnAddress: "0x" + "00".repeat(32),
        treasuryAddress: "0x" + "f7".repeat(32),
        networkFee: { burnPct: 50, treasuryPct: 50 },
        additionalFee: { burnPct: 25, treasuryPct: 75 },
        specialOps: { burnPct: 25, rpcPct: 50, treasuryPct: 25 },
    }
    demos._getNetworkParametersCached = async () => ({ networkFee: 1, rpcFee: 1 })
})

afterEach(() => {
    Object.assign(getSharedState, saved)
    demos._getNetworkParametersCached = savedParams
})

describe("confirm balance of a native transfer under gasFeeSeparation and feeBinding", () => {
    beforeEach(() => forks(true))

    it("confirms a sender holding exactly the amount plus the fee", async () => {
        balance = AMOUNT + FEE
        const data = await confirm(await transfer())
        expect(data.message).toBe("[Tx Validation] Transaction signature verified\n")
        expect(data.valid).toBe(true)
    })

    it("refuses a sender one OS short of the amount plus the fee", async () => {
        balance = AMOUNT + FEE - 1n
        const data = await confirm(await transfer())
        expect(data.valid).toBe(false)
        expect(data.message).toBe(
            `[Tx Validation] [FEE ERROR] sender balance ${AMOUNT + FEE - 1n} < amount ${AMOUNT} + fee ${FEE}\n`,
        )
    })

    it("refuses a sender that holds the amount but not the fee", async () => {
        balance = AMOUNT
        const data = await confirm(await transfer())
        expect(data.valid).toBe(false)
        expect(data.message).toContain("[FEE ERROR] sender balance")
    })
})

describe("confirm balance without feeBinding, as before", () => {
    it("checks the amount and the fee apart", async () => {
        forks(false)
        balance = AMOUNT
        const data = await confirm(await transfer())
        expect(data.valid).toBe(true)
    })
})
