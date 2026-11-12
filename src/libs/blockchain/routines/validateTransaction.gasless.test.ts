/**
 * The fee gate at confirm time once gasFeeSeparation is active. A gasless
 * type (identity, validator seat transactions) is confirmed for an account
 * that cannot pay the fee; a native transfer from the same account is
 * refused there. The balance is 1 OS: enough for the transfer, not the fee.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"

mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: () => {},
        info: () => {},
        warning: () => {},
        warn: () => {},
        error: () => {},
        only: () => {},
        custom: () => {},
    },
}))
mock.module("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getLastBlockNumber: async () => 100 },
}))
mock.module("src/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: {
        getAccountNonce: async () => 0,
        getAccountBalance: async () => 1n,
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
import type { ForkConfigByName } from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"
import { PEER, SENDER, chainIs, demos, handMade, onTheWire } from "src/libs/blockchain/validation/editBinding.fixtures"

const { confirmTransaction } = await import("./validateTransaction")

const FEE_ERROR = "[FEE ERROR]"
let savedForks: ForkConfigByName

const confirm = async (tx: Transaction) =>
    (await confirmTransaction(tx as never, SENDER)).data.message

beforeEach(() => {
    savedForks = getSharedState.forkConfig
    chainIs(true, 0)
    getSharedState.forkConfig.gasFeeSeparation.activationHeight = 0
    getSharedState.forkConfig.gasFeeSeparation.treasuryAddress = "0x" + "ab".repeat(32)
})

afterEach(() => {
    getSharedState.forkConfig = savedForks
})

describe("the fee gate for an account that cannot pay the fee", () => {
    it("refuses a native transfer", async () => {
        const tx = onTheWire(await DemosTransactions.pay(PEER, 1n, demos))
        expect(await confirm(tx)).toContain(FEE_ERROR)
    })

    it("lets an identity transaction and a validator stake through", async () => {
        const identity = await handMade("identity", {
            context: "zk",
            method: "zk_commitmentadd",
            payload: [{ commitment: "c1", provider: "github" }],
        })
        expect(await confirm(onTheWire(identity))).not.toContain(FEE_ERROR)
        const stake = onTheWire(await DemosTransactions.stake("0", "https://node.example", demos))
        expect(await confirm(stake)).not.toContain(FEE_ERROR)
    })
})
