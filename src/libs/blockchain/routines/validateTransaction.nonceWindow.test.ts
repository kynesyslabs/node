/**
 * The nonce window at confirm time. Once `nonceIntegrity` is active the pool
 * refuses a nonce more than MEMPOOL_MAX_NONCE_AHEAD past the sender's, so
 * confirmation refuses it too instead of handing the client a validity it
 * cannot use. The SDK builds and signs the transactions; the chain, the GCR
 * reads, admission and the validity signature are replaced.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"

let tip = 100
let confirmedNonce = 7
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
    default: { getLastBlockNumber: async () => tip },
}))
mock.module("src/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: {
        getAccountNonce: async () => confirmedNonce,
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
import type { ForkConfigByName } from "@/forks/forkConfig"
import { MEMPOOL_MAX_NONCE_AHEAD } from "@/utilities/constants"
import { getSharedState } from "@/utilities/sharedState"
import { PEER, SENDER, chainIs, demos, onTheWire } from "src/libs/blockchain/validation/editBinding.fixtures"

const { confirmTransaction } = await import("./validateTransaction")

const TOO_FAR = "Transaction nonce too far ahead"
const originalNonce = demos.getAddressNonce
let savedForks: ForkConfigByName

/** A native transfer signed by SENDER with `nonce`, as the RPC receives it. */
async function pay(nonce: number): Promise<Transaction> {
    demos.getAddressNonce = async () => nonce - 1
    try {
        const tx = onTheWire(await DemosTransactions.pay(PEER, 1_000_000_000n, demos))
        expect(tx.content.nonce).toBe(nonce)
        return tx
    } finally {
        demos.getAddressNonce = originalNonce
    }
}

const confirm = async (tx: Transaction) =>
    (await confirmTransaction(tx as never, SENDER)).data.message

function nonceIntegrity(height: number | null) {
    chainIs(true, 0)
    getSharedState.forkConfig.nonceIntegrity.activationHeight = height
    tip = 100
}

beforeEach(() => {
    savedForks = getSharedState.forkConfig
    confirmedNonce = 7
})

afterEach(() => {
    getSharedState.forkConfig = savedForks
    demos.getAddressNonce = originalNonce
})

describe("confirmTransaction behind nonceIntegrity", () => {
    beforeEach(() => nonceIntegrity(0))

    it("accepts the last nonce inside the window", async () => {
        const message = await confirm(await pay(confirmedNonce + MEMPOOL_MAX_NONCE_AHEAD))
        expect(message).not.toContain(TOO_FAR)
        expect(message).not.toContain("NONCE ERROR")
    })

    it("refuses the first nonce past the window and names the highest it would take", async () => {
        const first = confirmedNonce + MEMPOOL_MAX_NONCE_AHEAD + 1
        const result = await confirmTransaction((await pay(first)) as never, SENDER)

        expect(result.data.valid).toBe(false)
        expect(result.data.message).toBe(
            `[Tx Validation] [NONCE ERROR] ${TOO_FAR}. Expected <=${confirmedNonce + MEMPOOL_MAX_NONCE_AHEAD}, got: ${first}`,
        )
    })

    it("measures the window from the sender's confirmed nonce", async () => {
        confirmedNonce = 40
        const message = await confirm(await pay(40 + MEMPOOL_MAX_NONCE_AHEAD))
        expect(message).not.toContain(TOO_FAR)
    })

    it("still refuses a spent nonce as before", async () => {
        const message = await confirm(await pay(confirmedNonce))
        expect(message).toContain("Transaction nonce error. Expected >=8")
    })

    it("removes a client fee quote before signing a stale-nonce refusal", async () => {
        const tx = await pay(confirmedNonce)
        tx.attrs = { reference_block: 0, total_fee: "0" } as never

        const result = await confirmTransaction(tx as never, SENDER)

        expect(result.data.valid).toBe(false)
        expect(result.data.message).toContain("NONCE ERROR")
        expect(result.data.transaction.attrs).toEqual({ reference_block: 0 })
    })
})

describe("confirmTransaction without nonceIntegrity", () => {
    it("takes any nonce ahead while the fork is dormant", async () => {
        nonceIntegrity(null)
        const message = await confirm(await pay(confirmedNonce + MEMPOOL_MAX_NONCE_AHEAD + 50))
        expect(message).not.toContain(TOO_FAR)
    })

    it("takes it on tip H when the fork activates at H + 1", async () => {
        nonceIntegrity(101)
        const message = await confirm(await pay(confirmedNonce + MEMPOOL_MAX_NONCE_AHEAD + 1))
        expect(message).not.toContain(TOO_FAR)
    })

    it("refuses it from tip H when the fork activates at H", async () => {
        nonceIntegrity(100)
        const message = await confirm(await pay(confirmedNonce + MEMPOOL_MAX_NONCE_AHEAD + 1))
        expect(message).toContain(TOO_FAR)
    })
})
