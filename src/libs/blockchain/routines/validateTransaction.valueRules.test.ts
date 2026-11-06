/**
 * RPC confirm refuses, whatever the forks say, a native send whose args pay
 * another recipient or amount than its body names, an address spelled with
 * upper-case digits, and a native fee that names its own rpc account. The
 * SDK builds and signs the transactions; the chain, the GCR reads, admission
 * and the validity signature are replaced.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"

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
        getAccountBalance: async () => 1_000_000n * 1_000_000_000n,
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

const PEER_UPPER = "0x" + PEER.slice(2).toUpperCase()
const saved = {
    forkConfig: getSharedState.forkConfig,
    feeDistribution: getSharedState.feeDistribution,
    networkFee: getSharedState.networkFee,
    rpcFee: getSharedState.rpcFee,
    additionalFee: getSharedState.additionalFee,
}

const confirm = async (tx: Transaction) => (await confirmTransaction(tx as never, SENDER)).data

beforeEach(() => {
    // Every value fork dormant: the refusals below are this node's own.
    chainIs(true, 0)
    getSharedState.networkFee = 1
    getSharedState.rpcFee = 0
    getSharedState.additionalFee = 0
    getSharedState.forkConfig.gasFeeSeparation.activationHeight = 0
    getSharedState.feeDistribution = {
        burnAddress: "0x" + "00".repeat(32),
        treasuryAddress: "0x" + "f7".repeat(32),
        networkFee: { burnPct: 50, treasuryPct: 50 },
        additionalFee: { burnPct: 25, treasuryPct: 75 },
        specialOps: { burnPct: 25, rpcPct: 50, treasuryPct: 25 },
    }
})

afterEach(() => {
    Object.assign(getSharedState, saved)
})

describe("confirmTransaction", () => {
    it("confirms a transfer built by the SDK", async () => {
        const data = await confirm(onTheWire(await DemosTransactions.pay(PEER, 3n * OS, demos)))
        expect(data.message).toBe("[Tx Validation] Transaction signature verified\n")
        expect(data.valid).toBe(true)
    })

    it("refuses a send whose args pay another recipient than content.to", async () => {
        const tx = DemosTransactions.empty()
        tx.content.type = "native" as never
        tx.content.to = SENDER
        tx.content.amount = (3n * OS) as never
        tx.content.nonce = 8
        tx.content.timestamp = Date.now()
        tx.content.data = ["native", { nativeOperation: "send", args: [PEER, String(3n * OS)] }] as never
        const data = await confirm(onTheWire(await demos.sign(tx)))

        expect(data.valid).toBe(false)
        expect(data.message).toBe(
            "[Tx Validation] [STRUCTURE ERROR] native send pays another recipient than content.to\n",
        )
    })

    it("refuses a transfer to an upper-case spelling of an address", async () => {
        const data = await confirm(onTheWire(await DemosTransactions.pay(PEER_UPPER, 3n * OS, demos)))

        expect(data.valid).toBe(false)
        expect(data.message).toContain("[STRUCTURE ERROR] native send recipient is not a lowercase")
    })

    it("refuses a native fee that names the account its rpc share goes to", async () => {
        getSharedState.forkConfig.gasFeeSeparation.activationHeight = 0
        getSharedState.feeDistribution = {
            burnAddress: "0x" + "00".repeat(32),
            treasuryAddress: "0x" + "f7".repeat(32),
            networkFee: { burnPct: 50, treasuryPct: 50 },
            additionalFee: { burnPct: 25, treasuryPct: 75 },
            specialOps: { burnPct: 25, rpcPct: 50, treasuryPct: 25 },
        }
        const params = demos._getNetworkParametersCached
        const applyFee = demos._calculateAndApplyGasFee
        demos._getNetworkParametersCached = async () => {
            throw new Error("offline")
        }
        demos._calculateAndApplyGasFee = (raw: any) => {
            raw.content.transaction_fee = { network_fee: "1000000000", rpc_fee: "0", additional_fee: "0", rpc_address: SENDER }
            return raw
        }
        let tx: Transaction
        try {
            tx = onTheWire(await DemosTransactions.pay(PEER, 3n * OS, demos))
        } finally {
            demos._getNetworkParametersCached = params
            demos._calculateAndApplyGasFee = applyFee
        }

        const data = await confirm(tx)

        expect(data.valid).toBe(false)
        expect(data.message).toContain("[FEE ERROR] transaction_fee names an rpc_address")
    })
})
